import { getEvents } from '@/lib/sanity'
import Link from 'next/link'

export const revalidate = 60

const TYPE_CONFIG = {
  ticketed:   { badge: '🎟 Ticketed Event',     color: '#B8933A', textColor: '#2C1A0E' },
  public:     { badge: '🌐 Public Event · Free', color: 'rgba(245,240,232,0.12)', textColor: 'rgba(245,240,232,0.75)' },
  fundraiser: { badge: '🤝 Fundraiser',          color: 'rgba(30,100,60,0.4)', textColor: 'rgba(150,220,170,0.9)' },
  member:     { badge: '🍷 Members Only',        color: 'rgba(120,50,150,0.4)', textColor: 'rgba(210,170,255,0.9)' },
}

export default async function EventsPage() {
  const events = await getEvents()

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

      {/* HERO */}
      <section style={{background:'var(--brown-dark)', padding:'5rem 2rem', textAlign:'center', borderBottom:'1px solid var(--border-light)'}}>
        <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.6rem', letterSpacing:'0.4em', textTransform:'uppercase', color:'var(--gold)', marginBottom:'1rem'}}>Always Something Happening</p>
        <h1 style={{fontFamily:'Playfair Display, serif', fontSize:'clamp(2.5rem,6vw,4.5rem)', fontWeight:700, color:'#fff', letterSpacing:'0.06em', textTransform:'uppercase'}}>Events at The Quarry</h1>
        <div style={{width:50, height:1, background:'var(--gold)', margin:'1.25rem auto'}} />
      </section>

      {/* EVENTS LIST */}
      <div style={{maxWidth:900, margin:'0 auto', padding:'3.5rem 2rem 5rem'}}>
        {events.length === 0 ? (
          <div style={{textAlign:'center', padding:'4rem', fontFamily:'Cormorant Garamond, serif', fontSize:'1.1rem', fontStyle:'italic', color:'rgba(245,240,232,0.5)'}}>
            No upcoming events at this time. Check back soon!
          </div>
        ) : (
          <div style={{display:'flex', flexDirection:'column', gap:'1.5px', background:'var(--border-light)'}}>
            {events.map(ev => {
              const cfg = TYPE_CONFIG[ev.eventType] || TYPE_CONFIG.public
              const d = ev.date ? new Date(ev.date + 'T12:00:00') : null
              const month = d ? d.toLocaleDateString('en-US', {month:'short'}).toUpperCase() : ''
              const day = d ? d.getDate() : '—'
              const year = d ? d.getFullYear() : ''
              const pct = ev.capacity ? Math.min(100, Math.round((ev.registered / ev.capacity) * 100)) : 0

              return (
                <div key={ev._id} style={{background:'var(--brown-dark)', display:'grid', gridTemplateColumns:'90px 1fr'}}>
                  {/* DATE */}
                  <div style={{background:'rgba(0,0,0,0.25)', display:'flex', alignItems:'center', justifyContent:'center', padding:'1.5rem 1rem', borderRight:'1px solid var(--border-light)'}}>
                    <div style={{textAlign:'center'}}>
                      <span style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.52rem', fontWeight:700, letterSpacing:'0.15em', color:'var(--gold)', display:'block'}}>{month}</span>
                      <span style={{fontFamily:'Playfair Display, serif', fontSize:'2rem', fontWeight:700, color:'#fff', lineHeight:1, display:'block'}}>{day}</span>
                      <span style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.48rem', color:'rgba(245,240,232,0.4)', display:'block'}}>{year}</span>
                    </div>
                  </div>
                  {/* BODY */}
                  <div style={{padding:'1.75rem 2rem', display:'flex', flexDirection:'column', gap:'0.65rem'}}>
                    <span style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.5rem', fontWeight:700, letterSpacing:'0.15em', textTransform:'uppercase', padding:'3px 10px', display:'inline-block', width:'fit-content', background:cfg.color, color:cfg.textColor}}>{cfg.badge}</span>
                    <h3 style={{fontFamily:'Playfair Display, serif', fontSize:'1.15rem', fontWeight:600, color:'#fff', lineHeight:1.2}}>{ev.name}</h3>
                    <div style={{display:'flex', flexWrap:'wrap', gap:'0.5rem'}}>
                      {ev.time && <span style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.55rem', color:'rgba(245,240,232,0.6)', background:'rgba(255,255,255,0.06)', padding:'3px 8px'}}>🕐 {ev.time}</span>}
                      {ev.location && <span style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.55rem', color:'rgba(245,240,232,0.6)', background:'rgba(255,255,255,0.06)', padding:'3px 8px'}}>📍 {ev.location}</span>}
                      {ev.price && <span style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.55rem', color:'var(--gold-light)', background:'rgba(184,147,58,0.12)', padding:'3px 8px'}}>💵 {ev.price}</span>}
                    </div>
                    <p style={{fontFamily:'Cormorant Garamond, serif', fontSize:'0.95rem', fontStyle:'italic', color:'rgba(245,240,232,0.65)', lineHeight:1.7}}>{ev.description}</p>
                    {ev.priceNote && <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.58rem', color:'rgba(245,240,232,0.55)', borderLeft:'2px solid var(--gold)', paddingLeft:'0.75rem'}}>ℹ️ {ev.priceNote}</p>}
                    {/* CAPACITY BAR */}
                    {ev.registered > 0 && (
                      <div>
                        <div style={{display:'flex', justifyContent:'space-between', fontFamily:'Montserrat, sans-serif', fontSize:'0.52rem', marginBottom:'0.4rem'}}>
                          <span style={{color:'var(--gold-light)'}}>{ev.registered}{ev.capacity ? ` / ${ev.capacity}` : ''} Registered</span>
                          <span style={{color: ev.soldOut ? '#e05555' : 'rgba(245,240,232,0.5)'}}>{ev.soldOut ? 'Sold Out' : ev.capacity ? `${ev.capacity - ev.registered} Remaining` : ''}</span>
                        </div>
                        <div style={{height:3, background:'rgba(255,255,255,0.1)'}}>
                          <div style={{height:'100%', width:`${pct}%`, background: ev.soldOut ? '#9b2226' : pct >= 75 ? '#e07b39' : 'var(--gold)'}} />
                        </div>
                      </div>
                    )}
                    {/* BUTTON */}
                    {ev.soldOut ? (
                      <span style={{display:'inline-block', padding:'0.65rem 1.5rem', fontFamily:'Montserrat, sans-serif', fontSize:'0.6rem', fontWeight:700, letterSpacing:'0.15em', textTransform:'uppercase', background:'rgba(155,34,38,0.4)', color:'rgba(255,200,200,0.7)', width:'fit-content', marginTop:'0.25rem'}}>Sold Out</span>
                    ) : ev.eventType === 'member' ? (
                      <a href={ev.registerUrl || 'mailto:management@thequarrystl.com?subject=Wine Club Membership'} style={{display:'inline-block', padding:'0.65rem 1.5rem', fontFamily:'Montserrat, sans-serif', fontSize:'0.6rem', fontWeight:700, letterSpacing:'0.15em', textTransform:'uppercase', background:'rgba(120,50,150,0.5)', color:'rgba(220,180,255,0.95)', width:'fit-content', marginTop:'0.25rem'}}>Become a Member →</a>
                    ) : (
                      <a href={ev.registerUrl || `mailto:management@thequarrystl.com?subject=${encodeURIComponent(ev.name + ' - Registration')}`} style={{display:'inline-block', padding:'0.65rem 1.5rem', fontFamily:'Montserrat, sans-serif', fontSize:'0.6rem', fontWeight:700, letterSpacing:'0.15em', textTransform:'uppercase', background:'var(--gold)', color:'var(--brown-dark)', width:'fit-content', marginTop:'0.25rem'}}>Register Now →</a>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <footer style={{background:'#0F0A07', padding:'2.5rem 2rem', borderTop:'1px solid var(--border-light)', textAlign:'center'}}>
        <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.55rem', color:'rgba(255,255,255,0.3)', letterSpacing:'0.08em', lineHeight:2}}>
          © 2026 The Quarry · 3960 Highway Z, New Melle, MO 63385 · 636-224-8257
        </p>
      </footer>
    </main>
  )
}
