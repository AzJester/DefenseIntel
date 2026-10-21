import {hashPassword} from './auth.mjs';
// Plaintext is accepted only through hidden stdin, never through command arguments or output.
if(process.stdin.isTTY){process.stdin.setRawMode(true);process.stderr.write('Enter the owner password (hidden), then press Enter:\n');}
process.stdin.setEncoding('utf8');
let input='';
try{
  const password=await new Promise((resolve,reject)=>{
    process.stdin.on('data',chunk=>{
      for(const char of chunk){
        if(char==='\u0003'){reject(Error('Cancelled'));return;}
        if(char==='\r'||char==='\n'){if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.pause();resolve(input);return;}
        if(char==='\u007f'||char==='\b')input=input.slice(0,-1);else input+=char;
        if(Buffer.byteLength(input)>1024){reject(Error('Password is too long'));return;}
      }
    });
    process.stdin.on('end',()=>resolve(input));process.stdin.on('error',reject);
  });
  console.log(await hashPassword(password));
}catch(error){if(process.stdin.isTTY)process.stdin.setRawMode(false);console.error(error.message);process.exitCode=1;}
finally{input='';}
