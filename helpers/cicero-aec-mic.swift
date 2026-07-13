// cicero-aec-mic — echo-cancelled microphone capture for macOS.
//
// Streams raw signed 16-bit little-endian mono PCM at 16 kHz to stdout, so it's a
// drop-in for `rec -q -t raw -e signed-integer -b 16 -c 1 -r 16000 -`. The point
// of the native helper is the one thing sox can't do: macOS **Voice Processing**
// (acoustic echo cancellation + noise suppression + auto-gain) on the input, so
// the mic stops picking up Cicero's own TTS coming back through the speakers.
//
// Voice Processing is a single duplex I/O unit: its echo reference is the audio
// rendered through the SAME engine's output, and (critically on macOS) its input
// only runs when that output side is engaged. So the real mode is --play: TTS is
// piped in (16 kHz mono s16le on stdin), rendered to the speaker here, and that
// same signal is what the canceller subtracts from the mic.
//
// Usage:
//   cicero-aec-mic --play          duplex: play stdin PCM + capture AEC'd mic
//   cicero-aec-mic                 capture only (no echo reference rendered)
//   flags: --no-vp (disable voice processing), --agc (restore auto-gain; off by
//          default because it crushes clap transients + the barge-in VAD floor),
//          --debug (per-second peak/rms breadcrumbs)
//
// Build: swiftc -O -swift-version 5 -o cicero-aec-mic cicero-aec-mic.swift

import AVFoundation
import Foundation

let SAMPLE_RATE = 16000.0
let playEnabled = CommandLine.arguments.contains("--play")
let vpEnabled = !CommandLine.arguments.contains("--no-vp")
let agcEnabled = CommandLine.arguments.contains("--agc")
let debug = CommandLine.arguments.contains("--debug")

var dbgPeak: Float = 0
var dbgSumSq: Double = 0
var dbgFrames = 0

func die(_ msg: String) -> Never {
    FileHandle.standardError.write(("cicero-aec-mic: " + msg + "\n").data(using: .utf8)!)
    exit(1)
}

let engine = AVAudioEngine()
let input = engine.inputNode

// Enable AEC/NS (Voice Processing). Must happen before the graph is wired/started.
if vpEnabled {
    do { try input.setVoiceProcessingEnabled(true) }
    catch { die("could not enable voice processing: \(error)") }
    // AGC normalizes levels — it boosts quiet speech but LIMITS loud transients and
    // pumps the gain. That crushes clap peaks (clap detection is peak-based) and
    // poisons the relative VAD noise floor barge-in depends on. We don't need it
    // (our VAD is already floor-relative), so default it OFF; --agc restores it.
    input.isVoiceProcessingAGCEnabled = agcEnabled
}

let hwFormat = input.outputFormat(forBus: 0)
if hwFormat.sampleRate == 0 { die("no input device / sample rate 0 (mic permission?)") }

// hw mono @ hw rate (downmix target), then SRC mono → 16 kHz mono float.
guard let hwMono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: hwFormat.sampleRate, channels: 1, interleaved: false),
      let mono16k = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: SAMPLE_RATE, channels: 1, interleaved: false),
      let src = AVAudioConverter(from: hwMono, to: mono16k) else {
    die("could not build sample-rate converter from \(hwFormat)")
}

let out = FileHandle.standardOutput

input.installTap(onBus: 0, bufferSize: 1024, format: hwFormat) { (buffer, _) in
    let chans = Int(buffer.format.channelCount)
    let frames = Int(buffer.frameLength)
    if frames == 0 || chans == 0 { return }
    guard let chData = buffer.floatChannelData else { return }

    // Channel-agnostic downmix to mono (handles VPIO's multichannel input).
    guard let mono = AVAudioPCMBuffer(pcmFormat: hwMono, frameCapacity: AVAudioFrameCount(frames)) else { return }
    mono.frameLength = AVAudioFrameCount(frames)
    let dst = mono.floatChannelData![0]
    for i in 0..<frames { dst[i] = 0 }
    for c in 0..<chans { let p = chData[c]; for i in 0..<frames { dst[i] += p[i] } }
    let inv = 1.0 / Float(chans)
    for i in 0..<frames { dst[i] *= inv }

    // SRC hw-rate mono → 16 kHz mono.
    let ratio = SAMPLE_RATE / hwFormat.sampleRate
    let cap = AVAudioFrameCount(Double(frames) * ratio) + 32
    guard let conv = AVAudioPCMBuffer(pcmFormat: mono16k, frameCapacity: cap) else { return }
    var consumed = false
    var err: NSError?
    src.convert(to: conv, error: &err) { (_, status) in
        if consumed { status.pointee = .noDataNow; return nil }
        consumed = true
        status.pointee = .haveData
        return mono
    }
    if err != nil { return }

    let ch = conv.floatChannelData![0]
    let n = Int(conv.frameLength)
    if n == 0 { return }
    var bytes = [UInt8]()
    bytes.reserveCapacity(n * 2)
    for i in 0..<n {
        let clamped = max(-1.0, min(1.0, ch[i]))
        let a = abs(clamped); if a > dbgPeak { dbgPeak = a }
        dbgSumSq += Double(clamped) * Double(clamped)
        let s = Int16(clamped * 32767.0)
        bytes.append(UInt8(truncatingIfNeeded: s))
        bytes.append(UInt8(truncatingIfNeeded: s >> 8))
    }
    dbgFrames += n
    out.write(Data(bytes))
}

// Playback path: render 16 kHz mono s16le from stdin so the AEC has a reference.
// Wire output explicitly (player → mixer → output, all at the output's own
// format) — letting AVAudioEngine auto-connect mainMixer→output under VPIO is
// what triggered the -10875 init failure.
var player: AVAudioPlayerNode? = nil
if playEnabled {
    let p = AVAudioPlayerNode()
    player = p
    engine.attach(p)
    let outFmt = engine.outputNode.inputFormat(forBus: 0)
    engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outFmt)
    guard let playFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: SAMPLE_RATE, channels: 1, interleaved: false) else {
        die("could not build playback format")
    }
    engine.connect(p, to: engine.mainMixerNode, format: playFmt)

    Thread.detachNewThread {
        let stdin = FileHandle.standardInput
        let frames = 1600 // 100 ms
        let bytesPerChunk = frames * 2
        while true {
            let data = stdin.readData(ofLength: bytesPerChunk)
            if data.isEmpty { Thread.sleep(forTimeInterval: 0.02); continue }
            let count = data.count / 2
            guard let buf = AVAudioPCMBuffer(pcmFormat: playFmt, frameCapacity: AVAudioFrameCount(count)) else { continue }
            buf.frameLength = AVAudioFrameCount(count)
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                let s16 = raw.bindMemory(to: Int16.self)
                let d = buf.floatChannelData![0]
                for i in 0..<count { d[i] = Float(s16[i]) / 32768.0 }
            }
            p.scheduleBuffer(buf, completionHandler: nil)
        }
    }
}

engine.prepare()
do { try engine.start() } catch { die("engine failed to start: \(error)") }
player?.play()

// NOTE: there is deliberately NO SIGUSR1 "hard flush" of the player. Calling
// player.stop()/reset()/play() on the live Voice-Processing graph killed the
// input tap (mic went to digital silence after the first interrupt), so barge-in
// interrupt is handled entirely on the parent side: it stops feeding stdin and the
// shallow (~250 ms) playback queue drains on its own within a chunk or two. That
// keeps the duplex engine — and therefore the echo-cancelled mic — running.

FileHandle.standardError.write("cicero-aec-mic: up (hw \(Int(hwFormat.sampleRate))Hz \(hwFormat.channelCount)ch → 16000Hz mono, vp=\(vpEnabled), agc=\(agcEnabled), play=\(playEnabled))\n".data(using: .utf8)!)

if debug {
    var lastFrames = 0
    let timer = Timer(timeInterval: 1.0, repeats: true) { _ in
        let n = dbgFrames - lastFrames
        let rms = n > 0 ? (dbgSumSq / Double(n)).squareRoot() : 0
        FileHandle.standardError.write("dbg frames=\(dbgFrames) peak=\(String(format: "%.4f", dbgPeak)) rms=\(String(format: "%.4f", rms))\n".data(using: .utf8)!)
        dbgPeak = 0
        dbgSumSq = 0
        lastFrames = dbgFrames
    }
    RunLoop.current.add(timer, forMode: .common)
}

RunLoop.current.run()
