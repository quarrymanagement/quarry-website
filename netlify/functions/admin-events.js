exports.handler=async(event)=>{
const headers={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
if(event.httpMethod==='OPTIONS')return{statusCode:200,headers,body:''};
const adminPass=process.env.ADMIN_PASSWORD||'quarry2026';
const auth=event.headers['x-admin-password'];
if(auth!==adminPass)return{statusCode:401,headers,body:JSON.stringify({error:'Unauthorized'})};
const token=process.env.NETLIFY_AUTH_TOKEN;
const siteId='roaring-pegasus-444826';
const base='https://api.netlify.com/api/v1/blobs/'+siteId+'/quarry-events/';
if(event.httpMethod==='GET'){
const{eventId}=event.queryStringParameters||{};
if(eventId){
const r=await fetch(base+eventId,{headers:{Authorization:'Bearer '+token}});
if(!r.ok)return{statusCode:404,headers,body:JSON.stringify({error:'Not found'})};
const ev=await r.json();
let regs=[];
try{const rr=await fetch('https://api.netlify.com/api/v1/blobs/'+siteId+'/event-registrations/'+eventId,{headers:{Authorization:'Bearer '+token}});if(rr.ok){const d=await rr.json();regs=d.registrations||[];}}catch(e){}
return{statusCode:200,headers,body:JSON.stringify({...ev,registrations:regs})};
}
const listRes=await fetch('https://api.netlify.com/api/v1/blobs/'+siteId+'/quarry-events',{headers:{Authorization:'Bearer '+token}});
const list=listRes.ok?await listRes.json():[];
return{statusCode:200,headers,body:JSON.stringify(list)};
}
if(event.httpMethod==='POST'){
const data=JSON.parse(event.body||'{}');
if(!data.id)data.id='event-'+Date.now();
await fetch(base+data.id,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data)});
return{statusCode:200,headers,body:JSON.stringify({success:true,id:data.id})};
}
if(event.httpMethod==='DELETE'){
const{eventId}=event.queryStringParameters||{};
await fetch(base+eventId,{method:'DELETE',headers:{Authorization:'Bearer '+token}});
return{statusCode:200,headers,body:JSON.stringify({success:true})};
}
return{statusCode:405,headers,body:'Method not allowed'};
};