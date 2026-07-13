#!/usr/bin/env swift
// cicero-hotkey — Global hotkey listener for Cicero
// Registers a global hotkey via CGEventTap and prints events to stdout.
// Usage: cicero-hotkey [modifiers] [keycode]
//   Default: ctrl+shift+space (modifiers=0xC keycode=49)
// Output: Prints "HOTKEY\n" to stdout on each press, flushes immediately.
// Requires Accessibility permissions (System Preferences > Privacy > Accessibility)

import Cocoa

// Parse arguments: modifiers (hex bitmask) and keycode
// Modifier bits: shift=0x2, ctrl=0x4, alt/option=0x8, cmd=0x10
let modifierMask: UInt64
let targetKeyCode: UInt16

if CommandLine.arguments.count >= 3 {
    modifierMask = UInt64(CommandLine.arguments[1], radix: 16) ?? 0xC
    targetKeyCode = UInt16(CommandLine.arguments[2]) ?? 49
} else {
    // Default: ctrl+shift+space
    modifierMask = 0x6 // ctrl(0x4) + shift(0x2)
    targetKeyCode = 49  // space
}

// Flush stdout after every write
setbuf(stdout, nil)

func checkAccessibility() -> Bool {
    let options = [kAXTrustedCheckOptionPrompt.takeRetainedValue(): true] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

if !checkAccessibility() {
    fputs("ERROR: Accessibility permission required. Grant access in System Settings > Privacy > Accessibility.\n", stderr)
    // Continue anyway — the prompt dialog was shown, user may grant it
}

// CGEvent callback
let callback: CGEventTapCallBack = { (proxy, type, event, refcon) -> Unmanaged<CGEvent>? in
    guard type == .keyDown else {
        return Unmanaged.passRetained(event)
    }

    let keyCode = UInt16(event.getIntegerValueField(.keyboardEventKeycode))
    let flags = event.flags

    // Check modifier keys
    let modMask = UnsafeMutablePointer<UInt64>(OpaquePointer(refcon!))
    let targetMods = modMask.pointee
    let targetKey = UInt16(truncatingIfNeeded: modMask.advanced(by: 1).pointee)

    var matches = true
    if targetMods & 0x2 != 0 { matches = matches && flags.contains(.maskShift) }
    if targetMods & 0x4 != 0 { matches = matches && flags.contains(.maskControl) }
    if targetMods & 0x8 != 0 { matches = matches && flags.contains(.maskAlternate) }
    if targetMods & 0x10 != 0 { matches = matches && flags.contains(.maskCommand) }

    if matches && keyCode == targetKey {
        print("HOTKEY")
        // Consume the event so it doesn't propagate
        return nil
    }

    return Unmanaged.passRetained(event)
}

// Store config in a buffer the callback can access
var config: [UInt64] = [modifierMask, UInt64(targetKeyCode)]

let eventMask: CGEventMask = (1 << CGEventType.keyDown.rawValue)

guard let tap = config.withUnsafeMutableBufferPointer({ buf -> CFMachPort? in
    CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .defaultTap,
        eventsOfInterest: eventMask,
        callback: callback,
        userInfo: UnsafeMutableRawPointer(buf.baseAddress!)
    )
}) else {
    fputs("ERROR: Failed to create event tap. Check Accessibility permissions.\n", stderr)
    exit(1)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

fputs("READY\n", stderr)
CFRunLoopRun()
