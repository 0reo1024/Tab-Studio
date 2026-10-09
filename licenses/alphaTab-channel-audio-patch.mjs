/** MPL-2.0: reproducible source patch to alphaTab 1.8.4's worker synthesis.
 * Render each voice exactly once; retain the original mixed buffer/clock.
 */
export function channelAudio(source){
 function replace(a,b){if(!source.includes(a))throw new Error('alphaTab channel audio patch mismatch: '+a.slice(0,65));source=source.replace(a,b);}
 replace('processMidiMessage(e) {\n\t\tswitch (e.type)', 'processMidiMessage(e) {\n    this.studioCurrentTrack = e.track;\n\t\tswitch (e.type)');
 replace('voice.playingKey = key;', 'voice.playingKey = key;\n    voice.studioTrack = this.studioCurrentTrack;');
 replace('if (m.isMetronome && this.metronomeVolume > 0) {', 'if (m.isMetronome && this.metronomeVolume > 0) {\n    this.studioCurrentTrack = -1;');
 replace('v.playingChannel !== channel || v.playingKey !== key ||', 'v.playingChannel !== channel || (this.studioStems && v.studioTrack !== this.studioCurrentTrack) || v.playingKey !== key ||');
 replace('else voice.render(this, buffer, bufferPos, sampleCount, isChannelMuted);',`else {
   const stems = this.studioStems;
   if (!stems) voice.render(this, buffer, bufferPos, sampleCount, isChannelMuted);
   else {
     const key = voice.studioTrack >= 0 && channel !== this._metronomeChannel ? -voice.studioTrack - 1 : channel;
     let stem = stems.get(key);
     if (!stem) { stem = new Float32Array(buffer.length); stems.set(key, stem); }
     voice.render(this, stem, bufferPos, sampleCount, false);
   }
 }`);
 replace('let bufferPos = 0;\n\t\t\tfor (let i = 0; i < SynthConstants.MicroBufferCount; i++) {',`let bufferPos = 0;
   this.synthesizer.studioStems = new Map();
   const studioMidi = [];
   for (let i = 0; i < SynthConstants.MicroBufferCount; i++) {`);
 replace('this.output.addSamples(samples);\n\t\t\tif (this.sequencer.isFinished)',`const stems = [...this.synthesizer.studioStems].map(([channel, pcm]) => [channel, pcm.subarray(0, samples.length)]);
   for (const [, pcm] of stems) for (let j = 0; j < samples.length; j++) samples[j] += pcm[j];
   this.synthesizer.studioStems = undefined;
   this.output.studioStems = stems;
   this.output.studioMidi = studioMidi;
   this.output.addSamples(samples);
   if (this.sequencer.isFinished)`);
 replace('samples: Environment.prepareForPostMessage(samples)\n\t\t});\n\t}\n\tplay() {\n\t\tthis._main.postMessage',`samples: Environment.prepareForPostMessage(samples),
   studioStems: this.studioStems ?? [], studioMidi: this.studioMidi ?? []
  });
  this.studioStems = undefined;
 }
 play() {
  this._main.postMessage`);
 replace('bufferPos += SynthConstants.MicroBufferSize * SynthConstants.AudioChannels;',`for (const e of synthesizedEvents) if (e.event && (e.event.channel !== undefined || e.isMetronome)) studioMidi.push({ ...e.event, delay: bufferPos / 2 });
   bufferPos += SynthConstants.MicroBufferSize * SynthConstants.AudioChannels;`);
 // Direct route: stems go from this worker to the studio-output AudioWorklet over a
 // MessagePort, and the worklet's sample requests and played counts come back the
 // same way. The main thread only hands over the port; it no longer relays audio.
 replace('\t\t\tcase "alphaSynth.output.samplesPlayed":\n\t\t\t\tthis.samplesPlayed.trigger(data.samples);\n\t\t\t\tbreak;',`\t\t\tcase "alphaSynth.output.samplesPlayed":
\t\t\t\tthis.samplesPlayed.trigger(data.samples);
\t\t\t\tbreak;
   case "studio.port":
    this.studioPort?.close();
    this.studioPort = data.port ?? undefined;
    if (this.studioPort) this.studioPort.onmessage = (m) => { if (m.data.cmd === 'request') this.sampleRequest.trigger(); else if (m.data.cmd === 'played') this.samplesPlayed.trigger(m.data.frames); };
    break;`);
 replace('\taddSamples(samples) {\n\t\tthis._main.postMessage({\n\t\t\tcmd: "alphaSynth.output.addSamples",',`\taddSamples(samples) {
  if (this.studioPort) {
   const stems = this.studioStems ?? [];
   this.studioPort.postMessage({ cmd: 'add', frames: samples.length / 2, stems, midi: this.studioMidi ?? [] }, [...new Set(stems.map(([, pcm]) => pcm.buffer))]);
   this.studioStems = undefined;
   return;
  }
\t\tthis._main.postMessage({
\t\t\tcmd: "alphaSynth.output.addSamples",`);
 replace('\tresetSamples() {\n\t\tthis._main.postMessage({ cmd: "alphaSynth.output.resetSamples" });',`\tresetSamples() {
  this.studioPort?.postMessage({ cmd: 'reset' });
\t\tthis._main.postMessage({ cmd: "alphaSynth.output.resetSamples" });`);
 return source;
}
