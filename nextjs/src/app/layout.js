import './globals.css'

export const metadata = {
  title: 'The Quarry | New Melle, MO',
  description: 'Restaurant, bar, live music, and events in New Melle, Missouri.',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
