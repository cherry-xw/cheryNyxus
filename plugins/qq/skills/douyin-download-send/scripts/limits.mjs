import {open} from 'node:fs/promises'
export async function saveStream(url,file,headers,maximum,{signal,exact}={}) {
 const response=await fetch(url,{headers,redirect:'error',...(signal?{signal}:{})})
 if(response.status!==200 || !response.body) {await response.body?.cancel();throw new Error('Media request failed')}
 const length=Number(response.headers.get('content-length'))
 if(!Number.isSafeInteger(length) || length<=0 || length>maximum || (exact!==undefined && length!==exact)) {await response.body.cancel();throw new Error('SIZE_LIMIT_OR_UNKNOWN')}
 const handle=await open(file,'wx',0o600)
 let bytes=0
 try {for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maximum)throw new Error('SIZE_LIMIT');await handle.writeFile(chunk)}if(bytes!==length)throw new Error('Incomplete media')} finally {await handle.close();await response.body.cancel().catch(()=>{})}
}
