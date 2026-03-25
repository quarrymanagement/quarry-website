import {createClient} from '@sanity/client'
import imageUrlBuilder from '@sanity/image-url'

export const client = createClient({
  projectId: '4t94f56h',
  dataset: 'production',
  apiVersion: '2024-01-01',
  useCdn: true,
})

const builder = imageUrlBuilder(client)
export function urlFor(source) {
  return builder.image(source)
}

// ── QUERIES ──

export async function getEvents() {
  return client.fetch(`
    *[_type == "event" && active == true] | order(date asc) {
      _id, name, date, time, location, eventType, price, priceNote,
      capacity, registered, soldOut, description, registerUrl,
      fundraiserNote, dualRegister, featuredImage
    }
  `)
}

export async function getBands() {
  return client.fetch(`
    *[_type == "band" && active == true] | order(date asc) {
      _id, name, date, time, notes
    }
  `)
}

export async function getMenuSections() {
  return client.fetch(`
    *[_type == "menuSection" && active == true] | order(order asc) {
      _id, title, order,
      items[available != false] {name, description, price}
    }
  `)
}

export async function getDrinkSections() {
  return client.fetch(`
    *[_type == "drinkSection" && active == true] | order(order asc) {
      _id, title, order,
      items[available != false] {name, description, price}
    }
  `)
}

export async function getPressArticles() {
  return client.fetch(`
    *[_type == "pressArticle" && active == true] | order(date desc) {
      _id, outlet, headline, date, url, featured
    }
  `)
}

export async function getJobPostings() {
  return client.fetch(`
    *[_type == "jobPosting" && active == true] | order(_createdAt asc) {
      _id, title, department, description
    }
  `)
}

export async function getSiteSettings() {
  return client.fetch(`
    *[_type == "siteSettings"][0] {
      phone, email, address, instagramUrl, facebookUrl,
      hours, golfBayPrice, golfBallsIncluded, golfJackpot
    }
  `)
}

export async function getBeerGarden() {
  return client.fetch(`
    *[_type == "beerGarden"][0] {
      heroTitle, heroSubtitle, openingDate, description, features, timeline
    }
  `)
}
