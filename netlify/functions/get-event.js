const{getStore}=require('@netlify/blobs');
exports.handler=async(event,context)=>{
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:h,body:''};
  const{eventId}=(event.queryStringParameters||{});
  if(!eventId)return{statusCode:400,headers:h,body:JSON.stringify({error:'eventId required'})};
  try{
    const evStore=getStore({name:'quarry-events',consistency:'strong'});
    const ev=await evStore.get(eventId,{type:'json'});
    if(!ev)return{statusCode:404,headers:h,body:JSON.stringify({error:'Event not found'})};
    const regStore=getStore({name:'event-registrations',consistency:'strong'});
    let regs=[];
    try{const r=await regStore.get(eventId,{type:'json'});if(r)regs=r.registrations||[];}catch(e){}
    const takenTables=regs.filter(r=>r.seatType==='table').map(r=>r.tableId);
    const takenBarSeats=regs.filter(r=>r.seatType==='bar').flatMap(r=>r.seatIds||[]);
    return{statusCode:200,headers:h,body:JSON.stringify({...ev,takenTables,takenBarSeats,totalRegistered:regs.reduce((s,r)=>s+(r.partySize||1),0),registrationCount:regs.length,registrations:regs})};
  }catch(err){return{statusCode:500,headers:h,body:JSON.stringify({error:err.message,stack:err.stack})};}
};