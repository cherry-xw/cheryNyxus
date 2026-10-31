import fs from 'node:fs'
import { atomicJson, safePath } from '../../../../../plugins/qq/src/state.js'
import { cleanupQQConversation, convertQQConversationBundle } from './qqConversationMaintenance.js'
try{
  const args=process.argv.slice(2),command=args.shift(),options=new Map<string,string>();let apply=false,stopped=false
  for(let i=0;i<args.length;i++){const key=args[i]!;if(key==='--apply'){apply=true;continue}if(key==='--stopped'){stopped=true;continue}
    if(!['--db','--data-dir','--owner','--self-id','--operation-id','--input','--output'].includes(key)||options.has(key)||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error('INVALID_ARGUMENTS');options.set(key,args[++i]!)}
  const required=(key:string)=>{const value=options.get(key);if(!value)throw new Error('INVALID_ARGUMENTS');return value}
  if(command==='cleanup')console.log(JSON.stringify(cleanupQQConversation({db:required('--db'),dataDir:required('--data-dir'),owner:required('--owner'),selfId:required('--self-id'),operationId:required('--operation-id'),apply,stopped})))
  else if(command==='convert'){const file=required('--input');safePath(file);const result=convertQQConversationBundle(JSON.parse(fs.readFileSync(file,'utf8')))
    if(apply){const output=required('--output');safePath(output);if(fs.existsSync(output))throw new Error('OUTPUT_EXISTS');atomicJson(output,result.bundle)}
    console.log(JSON.stringify({mode:apply?'write-new-bundle':'preview',changes:result.changes}))
  }else throw new Error('INVALID_ARGUMENTS')
}catch(error){console.error(error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'QQ_CONVERSATION_MAINTENANCE_FAILED');process.exitCode=1}
