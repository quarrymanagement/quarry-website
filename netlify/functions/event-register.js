const Stripe=require('stripe');const{getStore}=require('@netlify/blobs');
exports.handler=async(event,context)=>{
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:h,body:''};
  if(event.httpMethod!=='POST')return{statusCode:405,headers:h,body:'Method not allowed'};
  try{
    const{eventId,firstName,lastName,email,phone,seatType,tableId,seatIds,partySize,ticketType}=JSON.parse(event.body||'{}');
    if(!eventId||!firstName||!email||!seatType)return{statusCode:400,headers:h,body:JSON.stringify({error:'Missing required fields'})};
    const stripe=Stripe(process.env.STRIPE_SECRET_KEY);
    const evStore=getStore('quarry-events');
    const ev=await evStore.get(eventId,{type:'json'});
    if(!ev)return{statusCode:404,headers:h,body:JSON.stringify({error:'Event not found'})};
    const regStore=getStore('event-registrations');
    let regs=[];
    try{const r=await regStore.get(eventId,{type:'json'});if(r)regs=r.registrations||[];}catch(e){}
    const takenTables=regs.filter(r=>r.seatType==='table').map(r=>r.tableId);
    const takenBarSeats=regs.filter(r=>r.seatType==='bar').flatMap(r=>r.seatIds||[]);
    if(seatType==='table'&&takenTables.includes(tableId))return{statusCode:409,headers:h,body:JSON.stringify({error:'Table already reserved. Please choose another.'})};
    if(seatType==='bar'&&(seatIds||[]).some(s=>takenBarSeats.includes(s)))return{statusCode:409,headers:h,body:JSON.stringify({error:'One or more bar seats already taken.'})};
    const qty=seatType==='table'?(ev.tableSize||6):(parseInt(partySize)||1);
    const pricePerSeat=ticketType==='premium'?ev.pricePremium:ev.priceBase;
    const session=await stripe.checkout.sessions.create({
      payment_method_types:['card'],mode:'payment',allow_promotion_codes:true,
      line_items:[{price_data:{currency:'usd',product_data:{name:ev.title+(seatType==='table'?' — Table '+tableId:' — Bar Seat(s)'),description:ticketType==='premium'?'Bottomless Mimosas/Bloody Marys + Brunch + Bingo':'Brunch + Bingo'},unit_amount:Math.round(pricePerSeat*100)},quantity:qty}],
      customer_email:email,metadata:{eventId,firstName,lastName:lastName||'',phone:phone||'',seatType,tableId:tableId||'',seatIds:(seatIds||[]).join(','),partySize:String(qty),ticketType:ticketType||'base'},
      success_url:'https://roaring-pegasus-444826.netlify.app/quarry-events?registered=1',
      cancel_url:'https://roaring-pegasus-444826.netlify.app/quarry-events'
    });
    return{statusCode:200,headers:h,body:JSON.stringify({checkoutUrl:session.url})};
  }catch(err){return{statusCode:500,headers:h,body:JSON.stringify({error:err.message})};}
};