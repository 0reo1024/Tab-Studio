/** A cancelled or failed write keeps the window open. */
export async function saveAndClose(save:()=>Promise<boolean>,close:()=>void):Promise<boolean>{
 try{if(!await save())return false;close();return true;}catch{return false;}
}
