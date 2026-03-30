const Stripe=require('stripe');
exports.handler=async(event)=>{
  const headers={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers,body:''};
  if(event.httpMethod!=='POST')return{statusCode:405,headers,body:'Method not allowed'};
  try{
    const{eventId,name,email,phone,partySize,seatType,tableId,barSeats,successUrl,cancelUrl}=JSON.parse(event.body||'{}');
    if(!eventId||!name||!email||!seatType)return{statusCode:400,headers,body:JSON.stringify({error:'Missing required fields'})};
    const token=process.env.NETLIFY_AUTH_TOKEN;
    const siteId='roaring-pegasus-444826';
    const evRes=await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-events/event-${eventId}`,{headers:{Authorization:'Bearer '+token}});
    if(!evRes.ok)return{statusCode:404,headers,body:JSON.stringify({error:'Event not found'})};
    const evData=await evRes.json();
    let registrations=[];
    try{const regRes=await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-registrations/event-${eventId}`,{headers:{Authorization:'Bearer '+token}});if(regRes.ok){const d=await regRes.json();registrations=d.registrations||[];}}catch(e){}
    const takenTables=registrations.filter(r=>r.seatType==='table').map(r=>r.tableId);
    const takenBar=[];registrations.filter(r=>r.seatType==='bar').forEach(r=>(r.barSeats||[]).forEach(s=>takenBar.push(s)));
    if(seatType==='table'&&takenTables.includes(tableId))return{statusCode:409,headers,body:JSON.stringify({error:'Table already reserved'})};
    if(seatType==='bar'&&(barSeats||[]).some(s=>takenBar.includes(s)))return{statusCode:409,headers,body:JSON.stringify({error:'Bar seat already taken'})};
    const qty=seatType==='table'?(evData.tableSeats||4):(barSeats?.length||1);
    const totalCents=evData.pricePerSeat*qty;
    if(totalCents===0){
      registrations.push({name,email,phone,partySize,seatType,tableId,barSeats,registeredAt:new Date().toISOString(),free:true});
      await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-registrations/event-${eventId}`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({registrations})});
      return{statusCode:200,headers,body:JSON.stringify({success:true,free:true})};
    }
    const stripe=Stripe(process.env.STRIPE_SECRET_KEY);
    const session=await stripe.checkout.sessions.create({mode:'payment',allow_promotion_codes:true,line_items:[{price_data:{currency:'usd',unit_amount:evData.pricePerSeat,product_data:{name:`${evData.name} — ${seatType==='table'?'Full Table':barSeats?.length+' Bar Seat(s)'}`,description:`${evData.date} at ${evData.time} | The Quarry`}},quantity:qty}],metadata:{eventId,name,email,phone:phone||'',partySize:String(partySize||1),seatType,tableId:tableId||'',barSeats:(barSeats||[]).join(',')},customer_email:email,success_url:(successUrl||'https://roaring-pegasus-444826.netlify.app/quarry-events')+'?registered=1&event='+encodeURIComponent(evData.name),cancel_url:cancelUrl||'https://roaring-pegasus-444826.netlify.app/quarry-events'});
    return{statusCode:200,headers,body:JSON.stringify({checkoutUrl:session.url})};
  }catch(err){return{statusCode:500,headers,body:JSON.stringify({error:err.message})};}
};