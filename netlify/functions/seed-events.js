const{getStore}=require('@netlify/blobs');
exports.handler=async(event,context)=>{
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  const store=getStore('quarry-events');
  const ev={id:'neon-bingo-apr-2026',title:'Ladies Neon Singo Bingo Brunch',subtitle:'Neon 80s Singo-Bingo',date:'April 12, 2026',dateISO:'2026-04-12',startTime:'8:40 AM',endTime:'11:40 AM',location:'The Quarry, 3960 State Hwy Z, Wentzville, MO 63385',description:'Get your neon on! Join us for a glowing 80s-themed Singo Bingo Brunch at The Quarry.',priceBase:35,pricePremium:45,priceBaseLabel:'Bingo + Brunch',pricePremiumLabel:'Bottomless Mimosas/Bloody Marys + Brunch + Bingo',tableCount:10,tableSize:6,barSeatCount:12,totalCapacity:72,status:'active',tags:['Ladies Event','Brunch','Bingo','80s Theme']};
  try{
    await store.setJSON(ev.id,ev);
    return{statusCode:200,headers:h,body:JSON.stringify({seeded:true,id:ev.id})};
  }catch(err){return{statusCode:500,headers:h,body:JSON.stringify({error:err.message})};}
};