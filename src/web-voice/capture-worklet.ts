/** Same-origin, versioned capture asset. One message is at most 2048 mono frames. */
export const CAPTURE_WORKLET = `class CiceroCapture extends AudioWorkletProcessor {
  constructor() { super(); this.frames = new Float32Array(2048); this.used = 0; }
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.frames[this.used++] = input[i];
        if (this.used === this.frames.length) {
          this.port.postMessage(this.frames, [this.frames.buffer]);
          this.frames = new Float32Array(2048); this.used = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('cicero-capture-v1', CiceroCapture);`;
