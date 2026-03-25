import {defineField, defineType} from 'sanity'

// Drink Item (standalone for schema reg)
export const drinkItem = defineType({
  name: 'drinkItem',
  title: 'Drink Item',
  type: 'document',
  fields: [
    defineField({name: 'name', title: 'Name', type: 'string'}),
    defineField({name: 'price', title: 'Price', type: 'string'}),
  ],
})

// Beer Garden (singleton)
export const beerGarden = defineType({
  name: 'beerGarden',
  title: 'Beer Garden',
  type: 'document',
  fields: [
    defineField({name: 'heroTitle', title: 'Hero Title', type: 'string', initialValue: 'Beer Garden'}),
    defineField({name: 'heroSubtitle', title: 'Hero Subtitle', type: 'string'}),
    defineField({name: 'openingDate', title: 'Opening Date / Label', type: 'string', placeholder: 'e.g. Summer 2026'}),
    defineField({name: 'description', title: 'Main Description', type: 'text', rows: 5}),
    defineField({
      name: 'features',
      title: 'Features / What\'s Coming',
      type: 'array',
      of: [{
        type: 'object',
        fields: [
          {name: 'icon', title: 'Emoji Icon', type: 'string', placeholder: 'e.g. 🎵'},
          {name: 'title', title: 'Title', type: 'string'},
          {name: 'description', title: 'Description', type: 'string'},
        ],
        preview: {select: {title: 'title', subtitle: 'icon'}},
      }],
    }),
    defineField({
      name: 'timeline',
      title: 'Planned Updates Timeline',
      type: 'array',
      of: [{
        type: 'object',
        fields: [
          {name: 'period', title: 'Time Period', type: 'string', placeholder: 'e.g. Spring 2026'},
          {name: 'title', title: 'Milestone Title', type: 'string'},
          {name: 'description', title: 'Description', type: 'string'},
          {name: 'badge', title: 'Status Badge', type: 'string', placeholder: 'e.g. In Planning, Upcoming'},
        ],
        preview: {select: {title: 'title', subtitle: 'period'}},
      }],
    }),
  ],
  preview: {prepare() { return {title: 'Beer Garden Page'} }},
})

// Press Article
export const pressArticle = defineType({
  name: 'pressArticle',
  title: 'Press Article',
  type: 'document',
  fields: [
    defineField({name: 'outlet', title: 'Publication / Outlet', type: 'string', placeholder: 'e.g. VoyageSTL Magazine', validation: Rule => Rule.required()}),
    defineField({name: 'headline', title: 'Headline', type: 'string', validation: Rule => Rule.required()}),
    defineField({name: 'date', title: 'Published Date', type: 'date'}),
    defineField({name: 'url', title: 'Article URL', type: 'url', validation: Rule => Rule.required()}),
    defineField({name: 'featured', title: 'Featured (show prominently)', type: 'boolean', initialValue: false}),
    defineField({name: 'active', title: 'Show on Website', type: 'boolean', initialValue: true}),
  ],
  orderings: [{title: 'Date (Newest First)', name: 'dateDesc', by: [{field: 'date', direction: 'desc'}]}],
  preview: {
    select: {title: 'headline', subtitle: 'outlet'},
  },
})

// Job Posting
export const jobPosting = defineType({
  name: 'jobPosting',
  title: 'Job Posting',
  type: 'document',
  fields: [
    defineField({name: 'title', title: 'Position Title', type: 'string', validation: Rule => Rule.required()}),
    defineField({
      name: 'department',
      title: 'Department',
      type: 'string',
      options: {
        list: [
          {title: 'Front of House', value: 'Front of House'},
          {title: 'Back of House', value: 'Back of House'},
          {title: 'Management', value: 'Management'},
          {title: 'Events', value: 'Events'},
          {title: 'Other', value: 'Other'},
        ],
      },
    }),
    defineField({name: 'description', title: 'Job Description', type: 'text', rows: 4}),
    defineField({name: 'active', title: 'Currently Hiring', type: 'boolean', initialValue: true}),
  ],
  preview: {
    select: {title: 'title', subtitle: 'department'},
  },
})

// Site Settings (singleton)
export const siteSettings = defineType({
  name: 'siteSettings',
  title: 'Site Settings',
  type: 'document',
  fields: [
    defineField({name: 'phone', title: 'Phone Number', type: 'string', initialValue: '636-224-8257'}),
    defineField({name: 'email', title: 'Email', type: 'string', initialValue: 'management@thequarrystl.com'}),
    defineField({name: 'address', title: 'Address', type: 'string', initialValue: '3960 Highway Z, New Melle, MO 63385'}),
    defineField({name: 'instagramUrl', title: 'Instagram URL', type: 'url'}),
    defineField({name: 'facebookUrl', title: 'Facebook URL', type: 'url'}),
    defineField({
      name: 'hours',
      title: 'Operating Hours',
      type: 'array',
      of: [{
        type: 'object',
        fields: [
          {name: 'day', title: 'Day', type: 'string'},
          {name: 'open', title: 'Opens', type: 'string'},
          {name: 'close', title: 'Closes', type: 'string'},
          {name: 'closed', title: 'Closed This Day', type: 'boolean', initialValue: false},
        ],
        preview: {select: {title: 'day', subtitle: 'open'}},
      }],
    }),
    defineField({name: 'golfBayPrice', title: 'Golf Bay Price', type: 'string', initialValue: '$60'}),
    defineField({name: 'golfBallsIncluded', title: 'Golf Balls Included per Bay', type: 'number', initialValue: 75}),
    defineField({name: 'golfJackpot', title: 'Hole-in-One Jackpot', type: 'string', initialValue: '$3,000'}),
  ],
  preview: {prepare() { return {title: 'Site Settings'} }},
})
