import { getSiteSettings } from '@/lib/sanity'
import Link from 'next/link'

export const revalidate = 60

export default async function HomePage() {
  const settings = await getSiteSettings()

  return (
    <main style={{minHeight:'100vh', background:'var(--charcoal)'}}>
      {/* NAV */}
      <header style={{background:'rgba(26,26,26,0.97)', borderBottom:'1px solid var(--border-light)', padding:'0 2rem', position:'sticky', top:0, zIndex:1000}}>
        <div style={{maxWidth:1200, margin:'0 auto', display:'flex', alignItems:'center', justifyContent:'space-between', height:80}}>
          <Link href="/" style={{fontFamily:'Playfair Display, serif', fontSize:'1.4rem', fontWeight:700, letterSpacing:'0.12em', color:'#fff', textTransform:'uppercase'}}>
            The Quarry
            <span style={{display:'block', fontSize:'0.5rem', letterSpacing:'0.3em', color:'rgba(255,255,255,0.6)', fontFamily:'Montserrat, sans-serif', fontWeight:400}}>New Melle, Missouri</span>
          </Link>
          <nav style={{display:'flex', gap:'1.5rem', alignItems:'center'}}>
            <Link href="/menu" style={{color:'var(--cream)', fontSize:'0.62rem', letterSpacing:'0.14em', textTransform:'uppercase'}}>Menu</Link>
            <Link href="/events" style={{color:'var(--cream)', fontSize:'0.62rem', letterSpacing:'0.14em', textTransform:'uppercase'}}>Events</Link>
            <Link href="/bands" style={{color:'var(--cream)', fontSize:'0.62rem', letterSpacing:'0.14em', textTransform:'uppercase'}}>Live Music</Link>
            <Link href="/press" style={{color:'var(--cream)', fontSize:'0.62rem', letterSpacing:'0.14em', textTransform:'uppercase'}}>Press</Link>
            <Link href="/careers" style={{color:'var(--cream)', fontSize:'0.62rem', letterSpacing:'0.14em', textTransform:'uppercase'}}>Careers</Link>
          </nav>
        </div>
      </header>

      {/* HERO */}
      <section style={{position:'relative', height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden'}}>
        <div style={{position:'absolute', inset:0, background:'linear-gradient(to bottom, rgba(15,10,5,0.4) 0%, rgba(15,10,5,0.6) 55%, rgba(15,10,5,0.9) 100%)', zIndex:1}} />
        <div style={{position:'absolute', inset:0, background:'var(--brown-dark)'}} />
        {/* YouTube embed */}
        <div style={{position:'absolute', inset:0, overflow:'hidden', zIndex:0}}>
          <iframe
            src="https://www.youtube.com/embed/NHSx9ZNQCMM?autoplay=1&mute=1&loop=1&playlist=NHSx9ZNQCMM&controls=0&showinfo=0&rel=0&modestbranding=1&playsinline=1"
            style={{position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', width:'56.25vh', height:'100vh', minWidth:'100vw', minHeight:'177.78vw', border:'none', pointerEvents:'none'}}
            allow="autoplay; encrypted-media"
          />
        </div>
        <div style={{position:'relative', zIndex:2, textAlign:'center', padding:'0 2rem'}}>
          <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.62rem', letterSpacing:'0.45em', textTransform:'uppercase', color:'var(--gold-light)', marginBottom:'1.25rem'}}>New Melle, Missouri</p>
          <h1 style={{fontFamily:'Playfair Display, serif', fontSize:'clamp(4rem,10vw,9rem)', fontWeight:700, lineHeight:0.88, color:'#fff', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:'0.6rem'}}>The Quarry</h1>
          <p style={{fontFamily:'Cormorant Garamond, serif', fontSize:'clamp(1rem,2.2vw,1.4rem)', fontStyle:'italic', color:'var(--cream)', opacity:0.85, marginBottom:'2.5rem'}}>Restaurant · Bar · Live Music · Events</p>
          <div style={{width:50, height:1, background:'var(--gold)', margin:'0 auto 2.5rem'}} />
          <Link href="/menu" style={{display:'inline-block', padding:'0.9rem 2.8rem', border:'1px solid var(--gold)', color:'var(--gold-light)', fontFamily:'Montserrat, sans-serif', fontSize:'0.65rem', fontWeight:600, letterSpacing:'0.28em', textTransform:'uppercase'}}>
            Explore Our Menu
          </Link>
        </div>
      </section>

      {/* QUICK LINKS */}
      <div style={{background:'var(--brown-dark)', padding:'3rem 2rem'}}>
        <div style={{maxWidth:1100, margin:'0 auto', display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'1.5px', background:'var(--border-mid)'}}>
          {[
            {label:'Events', href:'/events', emoji:'🎉'},
            {label:'Live Music', href:'/bands', emoji:'🎵'},
            {label:'Press', href:'/press', emoji:'📰'},
            {label:'Careers', href:'/careers', emoji:'💼'},
          ].map(item => (
            <Link key={item.href} href={item.href} style={{background:'var(--brown-dark)', padding:'2rem', textAlign:'center', display:'block', transition:'background 0.2s'}}>
              <div style={{fontSize:'2rem', marginBottom:'0.5rem'}}>{item.emoji}</div>
              <div style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.62rem', fontWeight:600, letterSpacing:'0.2em', textTransform:'uppercase', color:'var(--gold-light)'}}>{item.label}</div>
            </Link>
          ))}
        </div>
      </div>

      {/* FOOTER */}
      <footer style={{background:'#0F0A07', padding:'2.5rem 2rem', borderTop:'1px solid var(--border-light)', textAlign:'center'}}>
        <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.55rem', color:'rgba(255,255,255,0.3)', letterSpacing:'0.08em', lineHeight:2}}>
          © 2026 The Quarry · {settings?.address || '3960 Highway Z, New Melle, MO 63385'} · {settings?.phone || '636-224-8257'} · {settings?.email || 'management@thequarrystl.com'}
        </p>
      </footer>
    </main>
  )
}
