// Standalone M0 target. Never linked into NidusNativeApp.
import Foundation
import Virtualization
import Darwin

protocol SandboxBackend: AnyObject {
    var actualState: VZVirtualMachine.State { get }
    func start()
    func requestStop()
    func forceStop()
    func cleanup()
}
final class LinuxVMBackend: NSObject, SandboxBackend, VZVirtualMachineDelegate {
    private var machine: VZVirtualMachine!
    var exitWhenStopped = false
    var managerMode = false
    var stopping = false
    var stopConfirmed = false
    var lastHeartbeat = ProcessInfo.processInfo.systemUptime
    var runID = ""
    private var observation: NSKeyValueObservation?
    var actualState: VZVirtualMachine.State { machine.state }
    private let began = ProcessInfo.processInfo.systemUptime
    func event(_ action: String, _ extra: [String:Any] = [:]) {
        var item: [String:Any] = ["action":action,"actualState":machine == nil ? -1 : machine.state.rawValue,
                                 "elapsedSeconds":ProcessInfo.processInfo.systemUptime-began, "runID":runID]
        let names = [0:"stopped",1:"running",2:"paused",3:"failed",4:"starting",5:"pausing",6:"resuming",7:"stopping"]
        item["actualStateName"] = machine == nil ? "not-created" : names[machine.state.rawValue] ?? "other-transition"
        item.merge(extra) { _, new in new }
        if let data = try? JSONSerialization.data(withJSONObject:item,options:[.sortedKeys]) {
            FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
            if managerMode { FileHandle.standardOutput.synchronizeFile() }
        }
    }
    init(kernel: String, ramdisk: String, workspace: String, serial: String, mode: String, networkFD: Int32?) throws {
        super.init()
        guard ["ordinary","setsid","double-fork","nested"].contains(mode) else { throw NSError(domain:"Mode",code:1) }
        let config = VZVirtualMachineConfiguration()
        let loader = VZLinuxBootLoader(kernelURL:URL(fileURLWithPath:kernel))
        loader.initialRamdiskURL = URL(fileURLWithPath:ramdisk)
        loader.commandLine = "console=hvc0 rdinit=/init panic=-1 nidus_mode=\(mode)"
        config.bootLoader = loader; config.cpuCount = 2; config.memorySize = 512 * 1024 * 1024
        let console = VZVirtioConsoleDeviceSerialPortConfiguration()
        FileManager.default.createFile(atPath:serial,contents:nil,attributes:[.posixPermissions:0o600])
        console.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading:nil,fileHandleForWriting:try FileHandle(forWritingTo:URL(fileURLWithPath:serial)))
        config.serialPorts = [console]
        let filesystem = VZVirtioFileSystemDeviceConfiguration(tag:"workspace")
        filesystem.share = VZSingleDirectoryShare(directory:VZSharedDirectory(url:URL(fileURLWithPath:workspace),readOnly:false))
        config.directorySharingDevices = [filesystem]
        // No NAT, bridge, host socket, API credentials or original Vault shares.
        config.networkDevices = []
        if let fd = networkFD {
            let device = VZVirtioNetworkDeviceConfiguration()
            device.attachment = VZFileHandleNetworkDeviceAttachment(fileHandle:FileHandle(fileDescriptor:fd,closeOnDealloc:true))
            device.macAddress = VZMACAddress(string:"02:00:00:00:00:02")!
            config.networkDevices = [device]
        }
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        try config.validate()
        machine = VZVirtualMachine(configuration:config)
        machine.delegate = self
        observation = machine.observe(\.state,options:[.new]) { [weak self] _, _ in self?.event("state-observed") }
        event("create",["cpuCount":config.cpuCount,"memoryBytes":config.memorySize,"networkDevices":config.networkDevices.count])
    }
    func start() {
        event("start-request")
        machine.start { [weak self] result in
            switch result {
            case .success: self?.event("start-completed")
            case .failure(let error): self?.event("failed",["error":error.localizedDescription])
            }
        }
    }
    func requestStop() {
        event("requestStop")
        do { try machine.requestStop() } catch { event("requestStop-failed",["error":error.localizedDescription]) }
        // Completion is only recorded from actual VM state/delegate, never this request.
    }
    func forceStop() {
        event("forceStop-request")
        machine.stop { [weak self] error in
            if let error { self?.event("forceStop-failed",["error":error.localizedDescription]) }
            else {
                self?.event("forceStop-completed")
                if self?.managerMode == true { self?.confirmStop() }
                else if self?.exitWhenStopped == true { self?.cleanup() }
            }
        }
    }
    func confirmStop() {
        guard machine.state == .stopped else { return }
        stopConfirmed = true
        event("stop-confirmed")
        if managerMode { exit(0) }
    }
    func terminate(_ reason: String) {
        if stopConfirmed { return }
        guard !stopping else { event("duplicate-stop", ["reason":reason]); return }
        stopping = true
        event("termination-request", ["reason":reason])
        requestStop()
        DispatchQueue.main.asyncAfter(deadline:.now()+2) { [self] in
            if !stopConfirmed { forceStop() }
        }
        DispatchQueue.main.asyncAfter(deadline:.now()+7) { [self] in
            if !stopConfirmed { event("stop-unconfirmed"); exit(3) }
        }
    }
    func cleanup() {
        guard machine.state == .stopped else { event("cleanup-refused"); return }
        event("cleanup"); exit(0)
    }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) { event("guest-stopped"); if managerMode { confirmStop() } }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { event("failed",["error":error.localizedDescription]) }
}
let args = CommandLine.arguments
let managerMode = args.count == 9 && args[6] == "manager"
if !managerMode && args.count != 6 && args.count != 7 { fputs("kernel initrd workspace serial mode [networkFD]\n",stderr); exit(2) }
var backend: LinuxVMBackend!
var managerTimer: DispatchSourceTimer?
var started = false
do {
    backend = try LinuxVMBackend(kernel:args[1],ramdisk:args[2],workspace:args[3],serial:args[4],mode:args[5],networkFD:args.count==7 ? Int32(args[6]) : nil)
} catch { fputs("VM configuration failed: \(error)\n",stderr); exit(2) }
if managerMode {
    backend.managerMode = true
    backend.runID = args[7]
    backend.event("manager-ready")
    let timeout = Double(args[8]) ?? 15
    DispatchQueue.main.asyncAfter(deadline:.now()+timeout) { backend.terminate("execution-timeout") }
    let timer = DispatchSource.makeTimerSource(queue:.main)
    timer.schedule(deadline:.now()+1,repeating:1)
    timer.setEventHandler {
        if !backend.stopping && ProcessInfo.processInfo.systemUptime-backend.lastHeartbeat >= 5 {
            backend.terminate("heartbeat-expired")
        }
    }
    timer.resume()
    // Retain the timer for this diagnostic process lifetime.
    managerTimer = timer
} else { backend.start() }
DispatchQueue.global().async {
    while let line = readLine() {
        DispatchQueue.main.async {
            if managerMode {
                let parts = line.split(separator:" ",maxSplits:1).map(String.init)
                guard parts.count == 2 && parts[0] == backend.runID else {
                    backend.event("command-refused"); backend.terminate("invalid-command"); return
                }
                switch parts[1] {
                case "start":
                    if !started && !backend.stopping { started = true; backend.start() }
                    else { backend.event("command-refused") }
                case "heartbeat": backend.lastHeartbeat = ProcessInfo.processInfo.systemUptime
                case "cancel": backend.terminate("user-cancel")
                case "status": backend.event("status")
                default: backend.event("command-refused"); backend.terminate("invalid-command")
                }
                return
            }
            switch line {
            case "requestStop": backend.requestStop()
            case "forceStop": backend.forceStop()
            case "cleanup": backend.cleanup()
            default: backend.event("command-refused")
            }
        }
    }
    DispatchQueue.main.async { if managerMode { backend.terminate("worker-disconnected"); return }; backend.event("controller-disconnected"); backend.exitWhenStopped = true; if backend.actualState == .stopped { backend.cleanup() } else { backend.forceStop() } }
}
// Independent upper bound for diagnostic failure; not a proof of VM termination.
DispatchQueue.main.asyncAfter(deadline:.now()+45) { backend.event("watchdog-expired"); exit(3) }
dispatchMain()
