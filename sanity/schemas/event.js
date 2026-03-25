import {defineField, defineType} from 'sanity'

export default defineType({
  name: 'event',
  title: 'Event',
  type: 'document',
  fields: [
    defineField({
      name: 'name',
      title: 'Event Name',
      type: 'string',
      validation: Rule => Rule.required(),
    }),
    defineField({
      name: 'date',
      title: 'Date',
      type: 'date',
      validation: Rule => Rule.required(),
    }),
    defineField({
      name: 'time',
      title: 'Time',
      type: 'string',
      placeholder: 'e.g. 6:00 PM – 10:00 PM',
    }),
    defineField({
      name: 'location',
      title: 'Location',
      type: 'string',
      placeholder: 'e.g. The Building · The Quarry',
    }),
    defineField({
      name: 'eventType',
      title: 'Event Type',
      type: 'string',
      options: {
        list: [
          {title: '🎟 Ticketed Event', value: 'ticketed'},
          {title: '🌐 Public Event (Free)', value: 'public'},
          {title: '🤝 Fundraiser', value: 'fundraiser'},
          {title: '🍷 Members Only (Wine Club)', value: 'member'},
        ],
        layout: 'radio',
      },
      validation: Rule => Rule.required(),
    }),
    defineField({
      name: 'price',
      title: 'Price',
      type: 'string',
      placeholder: 'e.g. $25/person, Free, TBD, $0.00',
      description: 'For free RSVP events, enter "$0.00" and add a price note below',
    }),
    defineField({
      name: 'priceNote',
      title: 'Price Note (optional)',
      type: 'string',
      placeholder: 'e.g. Guests pay for food & drinks as normal. RSVP required.',
    }),
    defineField({
      name: 'capacity',
      title: 'Total Capacity',
      type: 'number',
      description: 'Leave blank for unlimited',
    }),
    defineField({
      name: 'registered',
      title: 'Currently Registered',
      type: 'number',
      initialValue: 0,
    }),
    defineField({
      name: 'soldOut',
      title: 'Sold Out?',
      type: 'boolean',
      initialValue: false,
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'text',
      rows: 4,
      validation: Rule => Rule.required(),
    }),
    defineField({
      name: 'registerUrl',
      title: 'Registration URL (optional)',
      type: 'url',
      description: 'External registration link. Leave blank to use email inquiry.',
    }),
    defineField({
      name: 'fundraiserNote',
      title: 'Fundraiser Note (optional)',
      type: 'string',
      placeholder: 'e.g. Registration managed by Timberland High School',
    }),
    defineField({
      name: 'dualRegister',
      title: 'Dual Registration? (e.g. Vendor + Guest)',
      type: 'boolean',
      initialValue: false,
    }),
    defineField({
      name: 'featuredImage',
      title: 'Event Image (optional)',
      type: 'image',
      options: {hotspot: true},
    }),
    defineField({
      name: 'active',
      title: 'Show on Website',
      type: 'boolean',
      initialValue: true,
    }),
  ],
  orderings: [
    {
      title: 'Date (Upcoming First)',
      name: 'dateAsc',
      by: [{field: 'date', direction: 'asc'}],
    },
  ],
  preview: {
    select: {
      title: 'name',
      subtitle: 'date',
      media: 'featuredImage',
    },
    prepare({title, subtitle}) {
      return {
        title,
        subtitle: subtitle ? new Date(subtitle + 'T12:00:00').toLocaleDateString('en-US', {weekday:'short', month:'long', day:'numeric', year:'numeric'}) : 'No date set',
      }
    },
  },
})
