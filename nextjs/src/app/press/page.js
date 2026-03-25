import { getPressArticles } from '@/lib/sanity'
import Link from 'next/link'

export const revalidate = 60

export default async function PressPage() {
  const articles = await getPressArticles()
  const featured = articles.filter(a => a.featured)
  const rest = articles.filter(a => !a.featured)

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
        <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.6rem', letterSpacing:'0.4em', textTransform:'uppercase', color:'var(--gold)', marginBottom:'1rem'}}>In the News</p>
        <h1 style={{fontFamily:'Playfair Display, serif', fontSize:'clamp(2.5rem,6vw,4.5rem)', fontWeight:700, color:'#fff', letterSpacing:'0.06em', textTransform:'uppercase'}}>Press & Media</h1>
        <div style={{width:50, height:1, background:'var(--gold)', margin:'1.25rem auto'}} />
      </section>

      <div style={{maxWidth:1000, margin:'0 auto', padding:'5rem 2rem'}}>
        {featured.map(article => (
          <a key={article._id} href={article.url} target="_blank" rel="noopener noreferrer"
            style={{display:'grid', gridTemplateColumns:'1fr auto', gap:'2rem', alignItems:'center', background:'var(--brown-dark)', padding:'3rem', marginBottom:'3rem', textDecoration:'none', border:'1px solid var(--border-mid)'}}>
            <div>
              <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.55rem', fontWeight:700, letterSpacing:'0.25em', textTransform:'uppercase', color:'var(--gold)', marginBottom:'0.5rem'}}>{article.outlet} · Featured</p>
              <h3 style={{fontFamily:'Playfair Display, serif', fontSize:'1.4rem', fontWeight:700, color:'#fff', lineHeight:1.2, marginBottom:'0.4rem'}}>{article.headline}</h3>
              {article.date && <p style={{fontFamily:'Cormorant Garamond, serif', fontSize:'0.95rem', fontStyle:'italic', color:'rgba(245,240,232,0.55)'}}>{new Date(article.date + 'T12:00:00').toLocaleDateString('en-US', {month:'long', year:'numeric'})}</p>}
            </div>
            <span style={{fontSize:'1.5rem', color:'var(--gold)'}}>→</span>
          </a>
        ))}

        <div style={{display:'flex', flexDirection:'column', gap:'1.5px', background:'var(--border-mid)'}}>
          {rest.map(article => (
            <a key={article._id} href={article.url} target="_blank" rel="noopener noreferrer"
              style={{display:'grid', gridTemplateColumns:'1fr auto', gap:'1.5rem', alignItems:'center', background:'#fff', padding:'2.25rem 2rem', textDecoration:'none'}}>
              <div>
                <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.55rem', fontWeight:700, letterSpacing:'0.25em', textTransform:'uppercase', color:'var(--gold)', marginBottom:'0.4rem'}}>{article.outlet}</p>
                <h3 style={{fontFamily:'Playfair Display, serif', fontSize:'1.1rem', fontWeight:600, color:'var(--brown-dark)', lineHeight:1.3, marginBottom:'0.3rem'}}>{article.headline}</h3>
                {article.date && <p style={{fontFamily:'Cormorant Garamond, serif', fontSize:'0.88rem', fontStyle:'italic', color:'var(--brown-warm)'}}>{new Date(article.date + 'T12:00:00').toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'})}</p>}
              </div>
              <span style={{fontSize:'1.25rem', color:'var(--gold)'}}>→</span>
            </a>
          ))}
        </div>

        {articles.length === 0 && (
          <div style={{textAlign:'center', padding:'4rem', fontFamily:'Cormorant Garamond, serif', fontSize:'1.1rem', fontStyle:'italic', color:'rgba(245,240,232,0.5)'}}>No press articles yet.</div>
        )}

        <div style={{background:'var(--brown-dark)', padding:'2.5rem', textAlign:'center', marginTop:'3rem', border:'1px solid var(--border-mid)'}}>
          <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.58rem', fontWeight:700, letterSpacing:'0.3em', textTransform:'uppercase', color:'var(--gold)', marginBottom:'0.75rem'}}>Media Inquiries</p>
          <h3 style={{fontFamily:'Playfair Display, serif', fontSize:'1.5rem', color:'#fff', marginBottom:'1rem'}}>Press Contact</h3>
          <a href="mailto:management@thequarrystl.com?subject=Press Inquiry" style={{display:'inline-block', padding:'0.85rem 2.25rem', background:'var(--gold)', color:'var(--brown-dark)', fontFamily:'Montserrat, sans-serif', fontSize:'0.62rem', fontWeight:700, letterSpacing:'0.18em', textTransform:'uppercase'}}>Contact for Press →</a>
        </div>
      </div>

      <footer style={{background:'#0F0A07', padding:'2.5rem 2rem', borderTop:'1px solid var(--border-light)', textAlign:'center'}}>
        <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.55rem', color:'rgba(255,255,255,0.3)', letterSpacing:'0.08em'}}>© 2026 The Quarry · 3960 Highway Z, New Melle, MO 63385</p>
      </footer>
    </main>
  )
}
