exports.handler=async(event)=>{
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  const token=process.env.NETLIFY_AUTH_TOKEN;
  const siteId='roaring-pegasus-444826';
  const ev={id:'neon-bingo-apr-2026',title:'Ladies Neon Singo Bingo Brunch',subtitle:'Neon 80s Singo-Bingo',date:'April 12, 2026',dateISO:'2026-04-12',startTime:'8:40 AM',endTime:'11:40 AM',location:'The Quarry, 3960 State Hwy Z, Wentzville, MO 63385',description:'Get your neon on! Join us for a glowing 80s-themed Singo Bingo Brunch at The Quarry.',priceBase:35,pricePremium:45,priceBaseLabel:'Bingo + Brunch',pricePremiumLabel:'Bottomless Mimosas/Bloody Marys + Brunch + Bingo',tableCount:10,tableSize:6,barSeatCount:12,totalCapacity:72,status:'active',tags:['Ladies Event','Brunch','Bingo','80s Theme']};
  const url='https://api.netlify.com/api/v1/blobs/'+siteId+'/quarry-events/'+ev.id;
  const existing=await fetch(url,{headers:{Authorization:'Bearer '+token}});
  if(!existing.ok){
    await fetch(url,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(ev)});
    return{statusCode:200,headers:h,body:JSON.stringify({seeded:true})};
  }
  return{statusCode:200,headers:h,body:JSON.stringify({seeded:false,message:'Event already exists'})};
};