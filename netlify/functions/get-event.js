exports.handler=async(event)=>{
const headers={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
if(event.httpMethod==='OPTIONS')return{statusCode:200,headers,body:''};
const{eventId}=event.queryStringParameters||{};
if(!eventId)return{statusCode:400,headers,body:JSON.stringify({error:'eventId required'})};
const token=process.env.NETLIFY_AUTH_TOKEN;
const siteId='roaring-pegasus-444826';
try{
const evRes=await fetch('https://api.netlify.com/api/v1/blobs/'+siteId+'/quarry-events/'+eventId,{headers:{Authorization:'Bearer '+token}});
if(!evRes.ok)return{statusCode:404,headers,body:JSON.stringify({error:'Event not found'})};
const ev=await evRes.json();
let regs=[];
try{const rr=await fetch('https://api.netlify.com/api/v1/blobs/'+siteId+'/event-registrations/'+eventId,{headers:{Authorization:'Bearer '+token}});if(rr.ok){const d=await rr.json();regs=d.registrations||[];}}catch(e){}
const takenTables=regs.filter(r=>r.seatType==='table').map(r=>r.tableId);
const takenBar=regs.filter(r=>r.seatType==='bar').flatMap(r=>r.seatIds||[]);
const totalReg=regs.reduce((s,r)=>s+(r.partySize||1),0);
return{statusCode:200,headers,body:JSON.stringify({...ev,takenTables,takenBar,totalRegistered:totalReg,registrationCount:regs.length})};
}catch(err){return{statusCode:500,headers,body:JSON.stringify({error:err.message})};}
};