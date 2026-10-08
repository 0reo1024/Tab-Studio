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
 return source;
}
