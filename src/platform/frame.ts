/** Binary IPC framing shared with src-tauri/src/frame.rs: u32 little-endian JSON
 * length, the JSON header, then raw bytes. File contents never go through JSON. */
const encoder=new TextEncoder(),decoder=new TextDecoder();
export function joinFrame(header:unknown,parts:Uint8Array[]=[]):Uint8Array{
 const head=encoder.encode(JSON.stringify(header)),out=new Uint8Array(4+head.length+parts.reduce((n,p)=>n+p.byteLength,0));
 new DataView(out.buffer).setUint32(0,head.length,true);out.set(head,4);let at=4+head.length;for(const part of parts){out.set(part,at);at+=part.byteLength;}
 return out;
}
export function splitFrame<T=unknown>(buffer:ArrayBuffer):{header:T;bytes:Uint8Array}{
 const length=new DataView(buffer).getUint32(0,true);
 return {header:JSON.parse(decoder.decode(new Uint8Array(buffer,4,length))) as T,bytes:new Uint8Array(buffer,4+length)};
}
