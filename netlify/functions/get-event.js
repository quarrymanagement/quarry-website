exports.handler=async(event)=>{
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:h,body:''};
  const{eventId}=(event.queryStringParameters||{});
  if(!eventId)return{statusCode:400,headers:h,body:JSON.stringify({error:'eventId required'})};
  const token=process.env.NETLIFY_AUTH_TOKEN;
  const siteId='roaring-pegasus-444826';
  try{
    const evRes=await fetch('https://api.netlify.com/api/v1/blobs/'+siteId+'/quarry-events/'+eventId,{headers:{Authorization:'Bearer '+token}});
    if(!evRes.ok)return{statusCode:404,headers:h,body:JSON.stringify({error:'Event not found'})};
    const ev=await evRes.json();
    let regs=[];
    try{const rRes=await fetch('https://api.netlify.com/api/v1/blobs/'+siteId+'/event-registrations/'+eventId,{headers:{Authorization:'Bearer '+token}});if(rRes.ok){const d=await rRes.json();regs=d.registrations||[];}}catch(e){}
    const takenTables=regs.filter(r=>r.seatType==='table').map(r=>r.tableId);
    const takenBarSeats=regs.filter(r=>r.seatType==='bar').flatMap(r=>r.seatIds||[]);
    return{statusCode:200,headers:h,body:JSON.stringify({...ev,takenTables,takenBarSeats,totalRegistered:regs.reduce((s,r)=>s+(r.partySize||1),0),registrationCount:regs.length,registrations:regs})};
  }catch(err){return{statusCode:500,headers:h,body:JSON.stringify({error:err.message})};}
};