// Host metadata helper, not an Agent shell. Every filesystem access is anchored to no-follow directory FDs.
import Foundation
import Darwin
import CryptoKit
var mutationPublished = false
struct Blocked: Error { let code: String }
func deny(_ code: String) throws -> Never { throw Blocked(code: code) }
func checked(_ fd: Int32) throws -> Int32 { if fd < 0 { try deny(errno == EEXIST ? "file_conflict" : "filesystem_denied") }; return fd }
func info(_ fd: Int32) throws -> stat { var s = stat(); if fstat(fd, &s) != 0 { try deny("stat_failed") }; return s }
func identity(_ s: stat) -> [String:String] { ["device":String(s.st_dev),"inode":String(s.st_ino),"birthtimeNs":String(Int64(s.st_birthtimespec.tv_sec)*1_000_000_000+Int64(s.st_birthtimespec.tv_nsec))] }
func version(_ s: stat) -> [String:String] { var v = identity(s); v["mtime"]="\(s.st_mtimespec.tv_sec):\(s.st_mtimespec.tv_nsec)"; v["ctime"]="\(s.st_ctimespec.tv_sec):\(s.st_ctimespec.tv_nsec)"; v["size"]=String(s.st_size); return v }
func rootFD(_ root: String, _ expected: [String:String]) throws -> Int32 {
    if !root.hasPrefix("/") || root.contains("\0") { try deny("unsafe_root") }
    var fd = try checked(open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
    do {
        for c in root.split(separator:"/",omittingEmptySubsequences:true) {
            if c == "." || c == ".." { try deny("unsafe_root") }
            let next = try checked(openat(fd,String(c),O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)); close(fd); fd=next
        }
        if identity(try info(fd)) != expected { try deny("root_replaced") }; return fd
    } catch { close(fd); throw error }
}
func components(_ path: String, directory: Bool = false) throws -> [String] {
    if directory && path == "." { return [] }
    if path.isEmpty || path.hasPrefix("/") || path.utf8.count > 1024 || path.rangeOfCharacter(from:.controlCharacters) != nil || path.contains("\\") { try deny("unsafe_path") }
    let parts = path.components(separatedBy:"/")
    for p in parts {
        let lower=p.lowercased()
        if p.isEmpty || p == "." || p == ".." || p.hasPrefix(".") || lower.contains("secret") || lower.contains("credential") || lower.contains("config") || lower.contains("token") || lower.contains("password") || lower.contains("auth") || lower.hasPrefix("env.") || lower.hasPrefix("id_rsa") || lower.hasPrefix("id_ed25519") || ["node_modules","keychain","package.json","package-lock.json","settings.json","settings.yaml","settings.yml","settings.toml","netrc","npmrc","pip.conf"].contains(lower) { try deny("protected_path") }
    }
    return parts
}
func directoryFD(_ root: Int32, _ parts: [String]) throws -> Int32 {
    var fd = try checked(dup(root))
    do { for p in parts { let n=try checked(openat(fd,p,O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)); close(fd);fd=n };return fd }
    catch { close(fd);throw error }
}
func allowedText(_ path: String) throws {
    let ext=(path as NSString).pathExtension.lowercased()
    if !["txt","md","markdown","csv","tsv","log","py","ts","tsx","js","jsx","mjs","cjs","swift","json","html","css","yaml","yml","toml","c","h","cpp","hpp","rs","go","java","xml","sql"].contains(ext) { try deny("unsupported_file_type") }
}
func readText(_ root: Int32, _ path: String) throws -> [String:Any] {
    let parts=try components(path);try allowedText(path)
    let parent=try directoryFD(root,Array(parts.dropLast()));defer{close(parent)}
    let fd=try checked(openat(parent,parts.last!,O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));defer{close(fd)}
    let before=try info(fd)
    if (before.st_mode & S_IFMT) != S_IFREG || before.st_nlink != 1 { try deny("unsafe_file") }
    if before.st_size > 65536 { try deny("file_too_large") }
    var data=Data(),buffer=[UInt8](repeating:0,count:8192)
    while true { let n=Darwin.read(fd,&buffer,buffer.count);if n<0 {try deny("read_failed")};if n==0{break};data.append(contentsOf:buffer.prefix(n));if data.count>65536{try deny("file_too_large")} }
    let again=try directoryFD(root,Array(parts.dropLast()));defer{close(again)}
    if identity(try info(again)) != identity(try info(parent)) {try deny("parent_replaced")}
    let after=try info(fd);var named=stat()
    if fstatat(parent,parts.last!,&named,AT_SYMLINK_NOFOLLOW) != 0 || version(before) != version(after) || version(before) != version(named) || named.st_nlink != 1 || (named.st_mode & S_IFMT) != S_IFREG {try deny("file_changed")}
    guard let content=String(data:data,encoding:.utf8),!data.contains(0),!data.contains(where:{$0<9 || ($0>13 && $0<32)}) else {try deny("binary_file")}
    return ["path":path,"content":content,"hash":SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined(),"version":version(before)]
}
func list(_ root: Int32, _ path: String) throws -> [[String:String]] {
    let fd=try directoryFD(root,components(path,directory:true));defer{close(fd)}
    guard let dir=fdopendir(try checked(dup(fd))) else {try deny("list_failed")};defer{closedir(dir)}
    var entries=[[String:String]](),count=0
    errno=0
    while let item=readdir(dir) {
        count += 1;if count>1002{try deny("scan_limit")}
        let name=withUnsafePointer(to:&item.pointee.d_name) { $0.withMemoryRebound(to:CChar.self,capacity:1024){String(cString:$0)} }
        if name=="." || name==".." {continue}
        let relative=path=="." ? name : path+"/"+name
        do { _=try components(relative) } catch {continue}
        var s=stat();if fstatat(fd,name,&s,AT_SYMLINK_NOFOLLOW) != 0{try deny("file_changed")}
        if (s.st_mode&S_IFMT)==S_IFDIR {entries.append(["path":relative,"kind":"directory"])}
        else if (s.st_mode&S_IFMT)==S_IFREG && s.st_nlink==1 {do {try allowedText(name);entries.append(["path":relative,"kind":"file"])}catch{continue}}
        errno=0
    }
    if errno != 0 {try deny("list_failed")}
    let again=try directoryFD(root,components(path,directory:true));defer{close(again)}
    if identity(try info(again)) != identity(try info(fd)) {try deny("parent_replaced")}
    return entries.sorted{$0["path"]! < $1["path"]!}
}
func run(_ r:[String:Any]) throws -> [String:Any] {
    guard let root=r["root"] as? String,let expected=r["identity"] as? [String:String],let op=r["operation"] as? String,let path=r["path"] as? String else {try deny("invalid_request")}
    let fd=try rootFD(root,expected);defer{close(fd)}
    var output:[String:Any]
    switch op {
    case "volume":
        guard let uuid = try URL(fileURLWithPath: root).resourceValues(forKeys: [.volumeUUIDStringKey]).volumeUUIDString else { try deny("volume_identity_unavailable") }
        output=["volumeUuid":uuid.lowercased()]
    case "read": output=try readText(fd,path)
    case "list": output=["entries":try list(fd,path)]
    case "inspect":
        let parts=try components(path);try allowedText(path)
        let parent=try directoryFD(fd,Array(parts.dropLast()));defer{close(parent)};var named=stat()
        if fstatat(parent,parts.last!,&named,AT_SYMLINK_NOFOLLOW) != 0 {
            if errno != ENOENT {try deny("filesystem_denied")};output=["exists":false]
        } else {output=["exists":true,"file":try readText(fd,path)]}
    case "create":
        let parts=try components(path);try allowedText(path)
        if parts.count != 1 {try deny("nested_create_disabled")}
        guard let content=r["content"] as? String,let data=content.data(using:.utf8),data.count<=65536,!data.contains(0),!data.contains(where:{$0<9 || ($0>13 && $0<32)}) else {try deny("invalid_content")}
        let temp=".nidus-stage-"+UUID().uuidString
        let out=try checked(openat(fd,temp,O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,0o600))
        var published=false
        defer {close(out);if !published{unlinkat(fd,temp,0)}}
        try data.withUnsafeBytes { p in var offset=0;while offset<data.count {let n=Darwin.write(out,p.baseAddress!.advanced(by:offset),data.count-offset);if n<=0{try deny("write_failed")};offset+=n} }
        if fsync(out) != 0 {try deny("write_failed")}
        let current=try rootFD(root,expected);close(current)
        if renameatx_np(fd,temp,fd,path,UInt32(RENAME_EXCL)) != 0 {try deny("file_conflict")};published=true;mutationPublished=true
        if fsync(fd) != 0 {try deny("outcome_unknown")}
        output=try readText(fd,path)
    default: try deny("operation_disabled")
    }
    // Never return content from a root whose registered name changed during the operation.
    do { let current=try rootFD(root,expected);close(current) } catch { if op=="create"{try deny("outcome_unknown")};throw error }
    return output
}
do {
    let data=FileHandle.standardInput.readData(ofLength:262145)
    if data.count>262144 {try deny("input_limit")}
    guard let request=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{try deny("invalid_request")}
    let output=try run(request);let result=try JSONSerialization.data(withJSONObject:["ok":true,"data":output],options:[.sortedKeys]);FileHandle.standardOutput.write(result)
} catch {
    let code=mutationPublished ? "outcome_unknown" : ((error as? Blocked)?.code ?? "filesystem_denied")
    let result=try! JSONSerialization.data(withJSONObject:["ok":false,"code":code]);FileHandle.standardOutput.write(result)
    exit(1)
}
