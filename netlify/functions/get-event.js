exports.handler=async(event)=>{
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:h,body:''};
  const{eventId}=(event.queryStringParameters||{});
  if(!eventId)return{statusCode:400,headers:h,body:JSON.stringify({error:'eventId required'})};
  const token=process.env.NETLIFY_AUTH_TOKEN;
  const site='roaring-pegasus-444826';
  try{
    const evRes=await fetch('https://api.netlify.com/api/v1/blobs/'+site+'/quarry-events/'+eventId,{headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}});
    if(!evRes.ok){const t=await evRes.text();return{statusCode:404,headers:h,body:JSON.stringify({error:'Event not found',detail:t})};}
    const ev=await evRes.json();
    const regRes=await fetch('https://api.netlify.com/api/v1/blobs/'+site+'/event-registrations/'+eventId,{headers:{Authorization:'Bearer '+token}});
    let regs=[];
    if(regRes.ok){try{const d=await regRes.json();regs=d.registrations||[];}catch(e){}}
    const takenTables=regs.filter(r=>r.seatType==='table').map(r=>r.tableId);
    const takenBarSeats=regs.filter(r=>r.seatType==='bar').flatMap(r=>r.seatIds||[]);
    return{statusCode:200,headers:h,body:JSON.stringify({...ev,takenTables,takenBarSeats,totalRegistered:regs.reduce((s,r)=>s+(r.partySize||1),0),registrationCount:regs.length,registrations:regs})};
  }catch(err){return{statusCode:500,headers:h,body:JSON.stringify({error:err.message})};}
};