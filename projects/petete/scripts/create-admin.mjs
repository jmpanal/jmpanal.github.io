import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
const origin=process.env.PETETE_ORIGIN||'https://www.jmpanal.com';
if(new URL(origin).protocol!=='https:' && new URL(origin).hostname!=='localhost') throw new Error('HTTPS is required');
const rl=createInterface({input:process.stdin,output:process.stdout});
const email=await rl.question('Administrator email: ');
const name=await rl.question('Administrator name: '); rl.close();
let mute=false;
const sink=new Writable({write(chunk,encoding,cb){if(!mute)process.stdout.write(chunk,encoding);cb();}});
const secretInput=createInterface({input:process.stdin,output:sink,terminal:true});
process.stdout.write('Administrator password (at least 12 characters): '); mute=true;
const password=await secretInput.question(''); secretInput.close(); mute=false; process.stdout.write('\n');
if(password.length<12||password.length>256) throw new Error('Password must contain 12 to 256 characters');
const token=randomBytes(32).toString('hex');
const set=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','put','ADMIN_BOOTSTRAP_TOKEN'],{input:token+'\n',encoding:'utf8'});
if(set.status!==0) {process.stderr.write(set.stderr||'Could not configure bootstrap secret');process.exit(1);}
const response=await fetch(origin+'/petete/api/admin/bootstrap',{method:'POST',headers:{'Content-Type':'application/json','Origin':origin,'Authorization':'Bearer '+token},body:JSON.stringify({email,name,password})});
if(!response.ok) {console.error('Administrator initialization failed:',response.status,await response.text());process.exit(1);}
console.log('Administrator initialized. Sign in at '+origin+'/petete/. The bootstrap endpoint now rejects further initialization.');
