// ActiveCampaign Contact Submission
// Netlify Serverless Function
//
// Environment variables required (set in Netlify dashboard):
//   AC_API_URL  - e.g. https://jasonmoss.api-us1.com
//   AC_API_KEY  - your ActiveCampaign API key
//
// Custom field IDs (update these with your actual IDs from ActiveCampaign):
const CUSTOM_FIELDS = {
  latest_ad: '97',     // Latest Ad
  latest_source: '45', // Latest Source
  // Add more custom fields as needed
};

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const data = JSON.parse(event.body);

    // Email is required
    if (!data.email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Email is required' }),
      };
    }

    // Build the contact object
    const contact = {
      email: data.email,
    };

    if (data.first_name) contact.firstName = data.first_name;
    if (data.last_name) contact.lastName = data.last_name;
    if (data.phone) contact.phone = data.phone;

    // Build custom field values
    const fieldValues = [];

    if (data.latest_ad && CUSTOM_FIELDS.latest_ad !== 'FIELD_ID_HERE') {
      fieldValues.push({ field: CUSTOM_FIELDS.latest_ad, value: data.latest_ad });
    }

    if (data.latest_source && CUSTOM_FIELDS.latest_source !== 'FIELD_ID_HERE') {
      fieldValues.push({ field: CUSTOM_FIELDS.latest_source, value: data.latest_source });
    }

    if (fieldValues.length > 0) {
      contact.fieldValues = fieldValues;
    }

    // Step 1: Create or update the contact
    const contactResponse = await fetch(`${process.env.AC_API_URL}/api/3/contact/sync`, {
      method: 'POST',
      headers: {
        'Api-Token': process.env.AC_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contact }),
    });

    if (!contactResponse.ok) {
      const errorText = await contactResponse.text();
      console.error('ActiveCampaign contact sync failed:', errorText);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to create contact' }),
      };
    }

    const contactResult = await contactResponse.json();
    const contactId = contactResult.contact.id;

    // Step 2: Apply tag if provided
    if (data.tag) {
      // First, find or create the tag
      const tagSearchResponse = await fetch(
        `${process.env.AC_API_URL}/api/3/tags?search=${encodeURIComponent(data.tag)}`,
        {
          headers: { 'Api-Token': process.env.AC_API_KEY },
        }
      );

      let tagId;
      const tagSearchResult = await tagSearchResponse.json();

      if (tagSearchResult.tags && tagSearchResult.tags.length > 0) {
        // Tag exists — find exact match
        const exactMatch = tagSearchResult.tags.find(
          (t) => t.tag.toLowerCase() === data.tag.toLowerCase()
        );
        tagId = exactMatch ? exactMatch.id : tagSearchResult.tags[0].id;
      } else {
        // Tag doesn't exist — create it
        const createTagResponse = await fetch(`${process.env.AC_API_URL}/api/3/tags`, {
          method: 'POST',
          headers: {
            'Api-Token': process.env.AC_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tag: { tag: data.tag, tagType: 'contact', description: '' },
          }),
        });
        const createTagResult = await createTagResponse.json();
        tagId = createTagResult.tag.id;
      }

      // Apply the tag to the contact
      await fetch(`${process.env.AC_API_URL}/api/3/contactTags`, {
        method: 'POST',
        headers: {
          'Api-Token': process.env.AC_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contactTag: { contact: contactId, tag: tagId },
        }),
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, contactId }),
    };
  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
