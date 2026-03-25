import { getJobPostings } from '@/lib/sanity'
import Link from 'next/link'

export const revalidate = 60

export default async function CareersPage() {
  const jobs = await getJobPostings()

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
        <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.6rem', letterSpacing:'0.4em', textTransform:'uppercase', color:'var(--gold)', marginBottom:'1rem'}}>Join the Team</p>
        <h1 style={{fontFamily:'Playfair Display, serif', fontSize:'clamp(2.5rem,6vw,4.5rem)', fontWeight:700, color:'#fff', letterSpacing:'0.06em', textTransform:'uppercase'}}>Careers</h1>
        <div style={{width:50, height:1, background:'var(--gold)', margin:'1.25rem auto'}} />
        <p style={{fontFamily:'Cormorant Garamond, serif', fontSize:'1rem', fontStyle:'italic', color:'rgba(245,240,232,0.7)'}}>Be part of something special at The Quarry</p>
      </section>

      <div style={{maxWidth:1000, margin:'0 auto', padding:'4rem 2rem 5rem'}}>
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1.5px', background:'var(--border-mid)', marginBottom:'3rem'}}>
          {jobs.map(job => (
            <div key={job._id} style={{background:'#fff', padding:'2rem'}}>
              <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.55rem', fontWeight:700, letterSpacing:'0.2em', textTransform:'uppercase', color:'var(--gold)', marginBottom:'0.4rem'}}>{job.department}</p>
              <h3 style={{fontFamily:'Playfair Display, serif', fontSize:'1.2rem', fontWeight:600, color:'var(--brown-dark)', marginBottom:'0.5rem'}}>{job.title}</h3>
              {job.description && <p style={{fontFamily:'Cormorant Garamond, serif', fontSize:'0.92rem', fontStyle:'italic', color:'var(--brown-warm)', lineHeight:1.6}}>{job.description}</p>}
            </div>
          ))}
          {jobs.length === 0 && (
            <div style={{gridColumn:'1/-1', background:'#fff', padding:'3rem', textAlign:'center', fontFamily:'Cormorant Garamond, serif', fontSize:'1rem', fontStyle:'italic', color:'var(--brown-warm)'}}>
              No open positions at this time — check back soon!
            </div>
          )}
        </div>

        {/* APPLICATION FORM */}
        <div style={{background:'var(--charcoal)', padding:'3rem'}}>
          <h2 style={{fontFamily:'Playfair Display, serif', fontSize:'1.75rem', color:'#fff', marginBottom:'0.4rem'}}>Apply Now</h2>
          <p style={{fontFamily:'Cormorant Garamond, serif', fontSize:'1rem', fontStyle:'italic', color:'rgba(245,240,232,0.6)', marginBottom:'2rem'}}>Fill out the form and our team will be in touch soon</p>
          <form onSubmit={(e) => {
            e.preventDefault()
            const d = new FormData(e.target)
            const subject = encodeURIComponent(`Job Application – ${d.get('position')} – ${d.get('firstName')} ${d.get('lastName')}`)
            const body = encodeURIComponent(`Name: ${d.get('firstName')} ${d.get('lastName')}\nEmail: ${d.get('email')}\nPhone: ${d.get('phone')}\nPosition: ${d.get('position')}\nAvailability: ${d.get('availability')}\n\nAbout:\n${d.get('bio')}`)
            window.location.href = `mailto:management@thequarrystl.com?subject=${subject}&body=${body}`
          }}>
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1.25rem'}}>
              {[
                {name:'firstName', placeholder:'First Name', label:'First Name'},
                {name:'lastName', placeholder:'Last Name', label:'Last Name'},
                {name:'email', placeholder:'Email Address', label:'Email', type:'email'},
                {name:'phone', placeholder:'Phone Number', label:'Phone', type:'tel'},
              ].map(f => (
                <div key={f.name}>
                  <label style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.58rem', fontWeight:600, letterSpacing:'0.15em', textTransform:'uppercase', color:'rgba(245,240,232,0.55)', display:'block', marginBottom:'0.4rem'}}>{f.label}</label>
                  <input name={f.name} type={f.type||'text'} placeholder={f.placeholder} required style={{width:'100%', padding:'0.85rem 1rem', border:'1px solid var(--border-mid)', background:'rgba(255,255,255,0.05)', color:'var(--cream)', fontFamily:'Montserrat, sans-serif', fontSize:'0.72rem', outline:'none'}} />
                </div>
              ))}
              <div style={{gridColumn:'1/-1'}}>
                <label style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.58rem', fontWeight:600, letterSpacing:'0.15em', textTransform:'uppercase', color:'rgba(245,240,232,0.55)', display:'block', marginBottom:'0.4rem'}}>Position</label>
                <select name="position" required style={{width:'100%', padding:'0.85rem 1rem', border:'1px solid var(--border-mid)', background:'rgba(255,255,255,0.05)', color:'var(--cream)', fontFamily:'Montserrat, sans-serif', fontSize:'0.72rem', outline:'none'}}>
                  <option value="">Select a position</option>
                  {jobs.map(j => <option key={j._id} value={j.title}>{j.title}</option>)}
                  <option value="Other / Open to Any">Other / Open to Any</option>
                </select>
              </div>
              <div style={{gridColumn:'1/-1'}}>
                <label style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.58rem', fontWeight:600, letterSpacing:'0.15em', textTransform:'uppercase', color:'rgba(245,240,232,0.55)', display:'block', marginBottom:'0.4rem'}}>Tell Us About Yourself</label>
                <textarea name="bio" rows={4} placeholder="Share a little about yourself and why you'd love to work at The Quarry..." style={{width:'100%', padding:'0.85rem 1rem', border:'1px solid var(--border-mid)', background:'rgba(255,255,255,0.05)', color:'var(--cream)', fontFamily:'Montserrat, sans-serif', fontSize:'0.72rem', outline:'none', resize:'vertical'}} />
              </div>
              <div style={{gridColumn:'1/-1'}}>
                <button type="submit" style={{width:'100%', padding:'1.1rem', background:'var(--gold)', color:'var(--brown-dark)', fontFamily:'Montserrat, sans-serif', fontSize:'0.7rem', fontWeight:700, letterSpacing:'0.25em', textTransform:'uppercase', border:'none', cursor:'pointer'}}>Submit Application →</button>
              </div>
            </div>
          </form>
        </div>
      </div>

      <footer style={{background:'#0F0A07', padding:'2.5rem 2rem', borderTop:'1px solid var(--border-light)', textAlign:'center'}}>
        <p style={{fontFamily:'Montserrat, sans-serif', fontSize:'0.55rem', color:'rgba(255,255,255,0.3)', letterSpacing:'0.08em'}}>© 2026 The Quarry · Equal opportunity employer</p>
      </footer>
    </main>
  )
}
