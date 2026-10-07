import Foundation
import AppKit
import OSAKit

// Static JXA source; request JSON is a handler argument, never executable source.
do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "MailHelper", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected the bundled mail.js path"]) }
    let source = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
    guard let language = OSALanguage(forName: "JavaScript") else { throw NSError(domain: "MailHelper", code: 2, userInfo: [NSLocalizedDescriptionKey: "JavaScript for Automation is unavailable"]) }
    let script = OSAScript(source: source, language: language)
    let input = FileHandle.standardInput.readDataToEndOfFile()
    _ = try JSONSerialization.jsonObject(with: input)
    var failure: NSDictionary?
    guard let result = script.executeHandler(withName: "dispatch", arguments: [String(decoding: input, as: UTF8.self)], error: &failure)?.stringValue,
          let data = result.data(using: .utf8) else {
        let reason = failure?[OSAScriptErrorMessageKey] as? String ?? "Mail automation failed. Grant Switchboard Apple Mail permission in Privacy & Security → Automation."
        throw NSError(domain: "MailHelper", code: 3, userInfo: [NSLocalizedDescriptionKey: reason])
    }
    _ = try JSONSerialization.jsonObject(with: data)
    FileHandle.standardOutput.write(data)
} catch {
    let result: [String: Any] = ["status": 502, "body": ["error": ["code": "mail_automation_error", "message": String(describing: error)]]]
    if let data = try? JSONSerialization.data(withJSONObject: result) { FileHandle.standardOutput.write(data) }
}
