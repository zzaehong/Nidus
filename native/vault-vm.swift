// Independent VM owner. No Vault mount, network device, Host shell, or recovery.
// Optional egress: with NIDUS_EGRESS_FD set, that inherited socket becomes the virtio console
// port "nidus.egress", the guest's only way out (see src/workspace/egress-channel.ts).
import Foundation
import Virtualization
import Darwin

final class Manager: NSObject, VZVirtualMachineDelegate {
    var diskFD: Int32 = -1
    let vm: VZVirtualMachine
    let input = Pipe(), output = Pipe()
    var stopping = false
    var confirmed = false
    var ready = false
    var buffer = Data()
    var timer: DispatchSourceTimer?
    func event(_ kind: String, _ extra: [String:Any] = [:]) {
        var record = extra
        record["event"] = kind; record["time"] = ISO8601DateFormatter().string(from: Date())
        record["frameworkState"] = vm.state.rawValue
        let bytes = try! JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        let line = bytes + Data([10])
        line.withUnsafeBytes { pointer in
            var offset=0
            while offset<line.count {
                let n=Darwin.write(STDOUT_FILENO,pointer.baseAddress!.advanced(by:offset),line.count-offset)
                if n<=0 {break};offset+=n
            }
        }
    }
    init(kernel: String, initrd: String, development: Bool, disk: String? = nil, fresh: Bool = false, diskId: String = "") throws {
        let config = VZVirtualMachineConfiguration()
        let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernel))
        boot.initialRamdiskURL = URL(fileURLWithPath: initrd)
        boot.commandLine = "console=hvc0 rdinit=/init panic=-1"
        if disk != nil { boot.commandLine += " nidus_cache=\(fresh ? "new" : "existing") nidus_disk=\(diskId)" }
        config.bootLoader = boot; config.cpuCount = 2; config.memorySize = (development ? 3072 : 512) * 1024 * 1024
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: input.fileHandleForReading, fileHandleForWriting: output.fileHandleForWriting)
        config.serialPorts = [serial]
        config.networkDevices = []; config.directorySharingDevices = []; config.storageDevices = []
        var lockedFD: Int32 = -1
        if let disk {
            guard development, UUID(uuidString:diskId) != nil else {throw NSError(domain:"cache",code:1)}
            lockedFD = Darwin.open(disk,O_RDWR|O_NOFOLLOW)
            var info=stat()
            guard lockedFD >= 0, fstat(lockedFD,&info)==0, (info.st_mode & S_IFMT)==S_IFREG, info.st_nlink==1, info.st_uid==getuid(), (info.st_mode & 0o077)==0, info.st_size==512*1024*1024 else {throw NSError(domain:"cache",code:2)}
            let attachment=try VZDiskImageStorageDeviceAttachment(url:URL(fileURLWithPath:disk),readOnly:false,cachingMode:.uncached,synchronizationMode:.full)
            config.storageDevices=[VZVirtioBlockDeviceConfiguration(attachment:attachment)]
        }
        if let text = ProcessInfo.processInfo.environment["NIDUS_EGRESS_FD"], let fd = Int32(text), fd > 2 {
            var info = stat()
            guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFSOCK else { throw NSError(domain: "egress", code: 1) }
            let link = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
            let port = VZVirtioConsolePortConfiguration()
            port.name = "nidus.egress"
            port.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: link, fileHandleForWriting: link)
            let console = VZVirtioConsoleDeviceConfiguration()
            console.ports[0] = port
            config.consoleDevices = [console]
        }
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        try config.validate(); vm = VZVirtualMachine(configuration: config)
        super.init(); diskFD=lockedFD; vm.delegate = self
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            if !bytes.isEmpty { DispatchQueue.main.async { self?.receive(bytes) } }
        }
    }
    func receive(_ bytes: Data) {
        buffer.append(bytes)
        if buffer.count > 262144 { buffer.removeAll(); stop("guest_output_limit"); return }
        while let end = buffer.firstIndex(of: 10) {
            let line = String(decoding: buffer[..<end], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            buffer.removeSubrange(...end)
            if line.hasPrefix("NIDUS_") {
                event("guest", ["line":line])
                if line.hasPrefix("NIDUS_READY") { ready = true; event("ready") }
            }
        }
    }
    func start() {
        event("starting")
        vm.start { [self] result in
            switch result {
            case .success: event("running")
            case .failure(let error): event("start_failed",["error":error.localizedDescription]); stop("start_failed")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now()+30) { [self] in if !ready { stop("boot_timeout") } }
    }
    func command(_ text: String) {
        guard !stopping, ready, text.utf8.count < 65536 else { event("command_rejected"); return }
        try? input.fileHandleForWriting.write(contentsOf: Data((text+"\n").utf8))
    }
    func stop(_ reason: String, force: Bool = false) {
        guard !stopping else { event("duplicate_stop"); return }; stopping = true
        event("stop_requested", ["reason":reason])
        if vm.state == .stopped { confirm(); return }
        if !force {
            try? input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8))
            do { try vm.requestStop() } catch { event("request_stop_failed") }
        }
        DispatchQueue.main.asyncAfter(deadline: .now()+(force ? 0 : 2)) { [self] in
            if confirmed { return }
            event("force_stop_requested")
            vm.stop { [self] error in
                if error == nil && vm.state == .stopped { event("force_stop_completed"); confirm() } else { event("force_stop_failed") }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now()+8) { [self] in
            if !confirmed { event("STOP_UNCONFIRMED"); exit(3) }
        }
    }
    func confirm() {
        guard vm.state == .stopped, !confirmed else { return }; confirmed = true
        event("STOP_CONFIRMED"); exit(0)
    }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) { confirm() }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { event("vm_failed"); stop("framework_failure") }
}
signal(SIGPIPE, SIG_IGN)
let args = CommandLine.arguments
guard args.count == 3 || ([4,7].contains(args.count) && args[3] == "development") else { exit(2) }
do {
    let manager = try Manager(kernel: args[1], initrd: args[2], development: args.count >= 4, disk:args.count==7 ? args[4] : nil, fresh:args.count==7 && args[5]=="new",diskId:args.count==7 ? args[6] : "")
    manager.start()
    // Controller loss requests stop, never asserts stop. Independent process owns confirmation.
    DispatchQueue.global().async {
        while let line = readLine() {
            DispatchQueue.main.async {
                if line == "stop" { manager.stop("user") }
                else if line == "force-stop" { manager.stop("user_force", force: true) }
                else if line == "start" { manager.event("duplicate_start") }
                else { manager.command(line) }
            }
        }
        DispatchQueue.main.async { manager.stop("controller_disconnected") }
    }
    dispatchMain()
} catch { FileHandle.standardError.write(Data("VM configuration failed: \(error)\n".utf8)); exit(2) }
