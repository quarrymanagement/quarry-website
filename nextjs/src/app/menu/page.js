import { getMenuSections } from '@/lib/sanity'
import Link from 'next/link'

export const revalidate = 60

export default async function MenuPage() {
  const sections = await getMenuSections()

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
        <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.6rem', letterSpacing:'0.4em', textTransform:'uppercase', color:'var(--gold)', marginBottom:'1rem'}}>Twisted Barrel Kitchen</p>
        <h1 style={{fontFamily:'Playfair Display, serif', fontSize:'clamp(2.5rem,6vw,4.5rem)', fontWeight:700, color:'#fff', letterSpacing:'0.06em', textTransform:'uppercase'}}>Food Menu</h1>
        <div style={{width:50, height:1, background:'var(--gold)', margin:'1.25rem auto'}} />
        <p style={{fontFamily:'Cormorant Garamond, serif', fontSize:'1rem', fontStyle:'italic', color:'rgba(245,240,232,0.7)'}}>Open Wednesday – Sunday · Happy Hour Wed all day, Thu–Fri 3–6 PM</p>
      </section>

      <div style={{maxWidth:1100, margin:'0 auto', padding:'3.5rem 2rem 5rem'}}>
        {sections.map(section => (
          <div key={section._id} style={{marginBottom:'3rem'}}>
            <div style={{display:'flex', alignItems:'center', gap:'1rem', marginBottom:'1.5rem'}}>
              <div style={{flex:1, height:1, background:'var(--border-mid)'}} />
              <h2 style={{fontFamily:'Playfair Display, serif', fontSize:'1.25rem', fontWeight:600, color:'#fff', letterSpacing:'0.1em', textTransform:'uppercase', whiteSpace:'nowrap'}}>{section.title}</h2>
              <div style={{flex:1, height:1, background:'var(--border-mid)'}} />
            </div>
            <div style={{display:'flex', flexDirection:'column', gap:'1.5px', background:'var(--border-light)'}}>
              {section.items?.map((item, i) => (
                <div key={i} style={{background:'var(--brown-dark)', padding:'1.25rem 1.5rem', display:'flex', justifyContent:'space-between', alignItems:'baseline', gap:'1rem'}}>
                  <div>
                    <h3 style={{fontFamily:'Playfair Display, serif', fontSize:'1rem', fontWeight:600, color:'var(--gold-light)', marginBottom:'0.25rem'}}>{item.name}</h3>
                    {item.description && <p style={{fontFamily:'Cormorant Garamond, serif', fontSize:'0.88rem', fontStyle:'italic', color:'rgba(245,240,232,0.6)', lineHeight:1.5}}>{item.description}</p>}
                  </div>
                  <span style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.8rem', fontWeight:600, color:'#fff', whiteSpace:'nowrap'}}>{item.price}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {sections.length === 0 && (
          <div style={{textAlign:'center', padding:'4rem', fontFamily:'Cormorant Garamond, serif', fontSize:'1.1rem', fontStyle:'italic', color:'rgba(245,240,232,0.5)'}}>
            Menu coming soon!
          </div>
        )}
      </div>

      <footer style={{background:'#0F0A07', padding:'2.5rem 2rem', borderTop:'1px solid var(--border-light)', textAlign:'center'}}>
        <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.55rem', color:'rgba(255,255,255,0.3)', letterSpacing:'0.08em'}}>© 2026 The Quarry · Prices subject to change</p>
      </footer>
    </main>
  )
}
