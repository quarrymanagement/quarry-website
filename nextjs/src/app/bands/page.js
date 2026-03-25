import { getBands } from '@/lib/sanity'
import Link from 'next/link'

export const revalidate = 60

export default async function BandsPage() {
  const bands = await getBands()

  return (
    <main>
      <header style={{background:'rgba(26,26,26,0.97)', borderBottom:'1px solid var(--border-light)', padding:'0 2rem', position:'sticky', top:0, zIndex:1000}}>
        <div style={{maxWidth:1200, margin:'0 auto', display:'flex', alignItems:'center', justifyContent:'space-between', height:80}}>
          <Link href="/" style={{fontFamily:'Playfair Display, serif', fontSize:'1.4rem', fontWeight:700, letterSpacing:'0.12em', color:'#fff', textTransform:'uppercase'}}>
            The Quarry<span style={{display:'block', fontSize:'0.5rem', letterSpacing:'0.3em', color:'rgba(255,255,255,0.6)', fontFamily:'Montserrat, sans-serif'}}>New Melle, Missouri</span>
          </Link>
          <Link href="/" style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.6rem', letterSpacing:'0.15em', textTransform:'uppercase', color:'var(--gold-light)'}}>← Back to Home</Link>
        </div>
      </header>

      <section style={{background:'var(--brown-dark)', padding:'5rem 2rem', textAlign:'center', borderBottom:'1px solid var(--border-light)'}}>
        <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.6rem', letterSpacing:'0.4em', textTransform:'uppercase', color:'var(--gold)', marginBottom:'1rem'}}>Every Weekend at The Quarry</p>
        <h1 style={{fontFamily:'Playfair Display, serif', fontSize:'clamp(2.5rem,6vw,4.5rem)', fontWeight:700, color:'#fff', letterSpacing:'0.06em', textTransform:'uppercase'}}>Live Music</h1>
        <div style={{width:50, height:1, background:'var(--gold)', margin:'1.25rem auto'}} />
      </section>

      <div style={{maxWidth:1100, margin:'0 auto', padding:'3.5rem 2rem 5rem'}}>
        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))', gap:'1.5px', background:'var(--border-light)'}}>
          {bands.map(band => {
            const d = band.date ? new Date(band.date + 'T12:00:00') : null
            const dateStr = d ? d.toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric', year:'numeric'}) : 'TBD'
            return (
              <div key={band._id} style={{background:'var(--brown-dark)', padding:'1.75rem 1.5rem'}}>
                <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.58rem', fontWeight:700, letterSpacing:'0.2em', textTransform:'uppercase', color:'var(--gold)', marginBottom:'0.4rem'}}>{dateStr}</p>
                <h3 style={{fontFamily:'Playfair Display, serif', fontSize:'1.2rem', fontWeight:600, color:'#fff', marginBottom:'0.3rem'}}>{band.name}</h3>
                <p style={{fontFamily:'Cormorant Garamond, serif', fontSize:'0.9rem', fontStyle:'italic', color:'rgba(245,240,232,0.6)'}}>{band.time}</p>
              </div>
            )
          })}
        </div>
        {bands.length === 0 && (
          <div style={{textAlign:'center', padding:'4rem', fontFamily:'Cormorant Garamond, serif', fontSize:'1.1rem', fontStyle:'italic', color:'rgba(245,240,232,0.5)'}}>
            Band schedule coming soon — follow us on Instagram for updates!
          </div>
        )}
        <div style={{background:'var(--brown-dark)', border:'1px solid var(--border-mid)', padding:'2rem', textAlign:'center', marginTop:'2rem'}}>
          <p style={{fontFamily:'Cormorant Garamond, serif', fontSize:'1rem', fontStyle:'italic', color:'rgba(245,240,232,0.7)', lineHeight:1.8}}>
            Interested in performing at The Quarry? Email us at{' '}
            <a href="mailto:management@thequarrystl.com" style={{color:'var(--gold-light)'}}>management@thequarrystl.com</a>
          </p>
        </div>
      </div>

      <footer style={{background:'#0F0A07', padding:'2.5rem 2rem', borderTop:'1px solid var(--border-light)', textAlign:'center'}}>
        <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.55rem', color:'rgba(255,255,255,0.3)', letterSpacing:'0.08em'}}>© 2026 The Quarry · 3960 Highway Z, New Melle, MO 63385</p>
      </footer>
    </main>
  )
}
