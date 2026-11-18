// Made-up people for scraper tests and the benchmark. Each one exercises
// something seen on the live LinkedIn page. The expected result of reading
// each page is derived from the same data, so the truth is exact.

export const PROFILES = [
  {
    // Grouped roles, pronouns, a 2nd-degree contact abroad.
    slug: 'aoife-murphy-test', name: 'Aoife Murphy', pronouns: 'She/Her', degree: '2nd',
    headline: 'Senior Data Scientist at Spotify | Recommendations', subline: 'Spotify · Trinity College Dublin',
    location: 'Dublin, County Dublin, Ireland',
    about: 'I build recommendation systems that help people find music they love.\nBefore Spotify I was a consultant at Accenture.\nAlways happy to talk to students moving to Ireland.',
    posts: ['We just open-sourced our evaluation toolkit for ranking models. Feedback welcome from anyone working on recsys!'],
    jobs: [
      { company: 'Spotify', total: '4 yrs 2 mos', location: 'Dublin, County Dublin, Ireland', roles: [
        { title: 'Senior Data Scientist', dates: 'Jan 2024 - Present · 2 yrs 11 mos', description: 'Ranking and evaluation for Home.' },
        { title: 'Data Scientist', dates: 'Oct 2021 - Dec 2023 · 2 yrs 3 mos', thumbs: 3 },
      ] },
      { title: 'Marketing Analytics Consultant', company: 'Accenture', type: 'Full-time', dates: 'Sep 2018 - Sep 2021 · 3 yrs 1 mo', location: 'Dublin, Ireland · Hybrid' },
    ],
    education: [{ school: 'Trinity College Dublin', degree: 'MSc, Computer Science', dates: '2017 – 2018' }],
    skills: [{ name: 'Python', context: 'Senior Data Scientist at Spotify' }, { name: 'Recommender Systems', context: 'Endorsed by 4 colleagues at Spotify' }, { name: 'SQL' }],
  },
  {
    // Locations abroad that v3 did not recognise, a media caption and a
    // thumbnail counter right after the dates.
    slug: 'liam-byrne-test', name: 'Liam Byrne', degree: '3rd',
    headline: 'Engineering Manager at Stripe', location: 'London, England, United Kingdom',
    about: 'Engineering manager. Payments, reliability, mentoring.',
    posts: [],
    jobs: [
      { title: 'Engineering Manager', company: 'Stripe', type: 'Full-time', dates: 'Mar 2022 - Present · 4 yrs 9 mos', location: 'London, England, United Kingdom', present: true, caption: 'Stripe Sessions – How we scaled payouts.', thumbs: 5 },
      { title: 'Junior Software Engineer', company: 'Monzo', type: 'Full-time', dates: 'Jun 2016 - Feb 2022 · 5 yrs 9 mos', location: 'London, England, United Kingdom' },
      { title: 'Software Engineering Intern', company: 'Google', type: 'Internship', dates: 'Jun 2015 - Aug 2015 · 3 mos', location: 'Zürich, Switzerland' },
    ],
    education: [{ school: 'University of Edinburgh', degree: 'BSc, Computer Science' }],
    skills: [{ name: 'Distributed Systems' }, { name: 'Go', context: 'Engineering Manager at Stripe' }],
  },
  {
    // Indian education, now in Germany; a title with a month inside it (B1).
    slug: 'priya-nair-test', name: 'Priya Nair', degree: '2nd',
    headline: 'ML Engineer @ Zalando · ex-IIT Madras', location: 'Berlin, Germany',
    about: 'Machine learning engineer in Berlin.\nI moved from Chennai to Munich for my Masters and stayed in Germany.',
    posts: ['Three things I wish I knew before moving to Germany for my Masters: register your address early, learn basic German, and network before you graduate.'],
    jobs: [
      { title: 'Machine Learning Engineer', company: 'Zalando', type: 'Full-time', dates: 'Apr 2023 - Present · 3 yrs 8 mos', location: 'Berlin, Germany · Hybrid', present: true },
      { title: 'Doctoral Researcher', company: 'Technical University of Munich', type: 'Full-time', dates: 'Oct 2019 - Mar 2023 · 3 yrs 6 mos', location: 'Munich, Bavaria, Germany' },
    ],
    education: [
      { school: 'Technical University of Munich', degree: 'MSc, Informatics', dates: '2017 – 2019' },
      { school: 'Indian Institute of Technology, Madras', degree: 'BTech, Electrical Engineering', dates: '2013 – 2017' },
    ],
    skills: [{ name: 'PyTorch', context: 'Machine Learning Engineer at Zalando' }, { name: 'German', context: 'Doctoral Researcher at Technical University of Munich' }],
  },
  {
    // Your own profile: owner view, pronouns, location inside the job link,
    // skill links under each job.
    slug: 'rahul-sharma-test', name: 'Rahul Sharma', pronouns: 'He/Him', owner: true,
    headline: 'Data Analyst | MSc Data Analytics, UCD', subline: 'University College Dublin',
    location: 'Mumbai, Maharashtra, India',
    about: 'Data analyst finishing an MSc in Dublin.\nLooking for analytics roles in Ireland.',
    posts: ['Finished my MSc dissertation on churn prediction! Grateful to my supervisor and classmates.'],
    jobs: [
      { title: 'Data Analyst Intern', company: 'Flipkart', type: 'Internship', dates: 'May 2024 - Jul 2024 · 3 mos', location: 'Bengaluru, Karnataka, India · On-site', skills: 'SQL, Tableau and +2 skills' },
      { title: 'Business Analyst', company: 'Infosys', type: 'Full-time', dates: 'Aug 2021 - Aug 2023 · 2 yrs 1 mo', location: 'Remote', skills: 'Excel and +4 skills' },
    ],
    education: [
      { school: 'University College Dublin', degree: 'MSc, Data Analytics', dates: 'Sep 2024 – Aug 2025' },
      { school: 'University of Mumbai', degree: 'BCom', dates: '2018 – 2021' },
    ],
    skills: [{ name: 'SQL', context: 'Data Analyst Intern at Flipkart' }, { name: 'Tableau' }],
  },
  {
    // A connection (1st degree), one-word location, no About, no posts.
    slug: 'sean-obrien-test', name: "Seán O'Brien", degree: '1st',
    headline: 'Technical Recruiter at Workday', location: 'Ireland',
    about: null, posts: [],
    jobs: [{ title: 'Technical Recruiter', company: 'Workday', type: 'Full-time', dates: 'Feb 2020 - Present · 6 yrs 10 mos', location: 'Dublin, Ireland', present: true }],
    education: [{ school: 'University College Cork', degree: 'BA, Psychology' }],
    skills: [{ name: 'Technical Recruiting' }],
  },
  {
    // Three roles at one company, and a title starting with "Aug".
    slug: 'maria-rossi-test', name: 'Maria Rossi', degree: '2nd',
    headline: 'Staff Engineer at Google', location: 'Toronto, Ontario, Canada',
    about: 'Building AR experiences at Google.',
    posts: [],
    jobs: [
      { company: 'Google', total: '7 yrs 1 mo', location: 'Toronto, Ontario, Canada', roles: [
        { title: 'Staff Engineer', dates: 'Jan 2024 - Present · 2 yrs 11 mos' },
        { title: 'Augmented Reality Engineer', dates: 'Feb 2021 - Dec 2023 · 2 yrs 11 mos', description: 'ARCore depth API.' },
        { title: 'Software Engineer', dates: 'Nov 2019 - Jan 2021 · 1 yr 3 mos', location: 'Waterloo, Ontario, Canada' },
      ] },
    ],
    education: [{ school: 'University of Toronto', degree: 'MEng, Electrical and Computer Engineering', dates: '2017 – 2019' }],
    skills: [{ name: 'C++', context: 'Staff Engineer at Google' }, { name: 'Computer Vision' }],
  },
  {
    // An invite you already sent (Pending), single-place location.
    slug: 'wei-chen-test', name: 'Wei Chen', degree: '2nd', relationship: 'pending',
    headline: 'Product Manager at Notion', location: 'San Francisco Bay Area',
    about: 'PM at Notion. Previously founder of a small edtech startup.',
    posts: ['Hiring: Product Manager, Growth. DM me if you have shipped onboarding experiments before.'],
    jobs: [
      { title: 'Product Manager', company: 'Notion', type: 'Full-time', dates: 'Jul 2022 - Present · 4 yrs 5 mos', location: 'San Francisco Bay Area', present: true },
      { title: 'Founder', company: 'Lumen Learning Labs', dates: '2018 – 2022', location: 'Singapore' },
    ],
    education: [{ school: 'National University of Singapore', degree: 'BComp, Computer Science' }],
    skills: [{ name: 'Product Management', context: 'Product Manager at Notion' }],
  },
  {
    // Remote and hybrid roles in the Gulf, a Mar- title (B1).
    slug: 'fatima-khan-test', name: 'Fatima Khan', degree: '3rd',
    headline: 'Marketing Manager, MENA at Careem', location: 'Dubai, United Arab Emirates',
    about: 'Growth marketer.\nPreviously in Bengaluru, now in Dubai.',
    posts: [],
    jobs: [
      { title: 'Marketing Manager, MENA', company: 'Careem', type: 'Full-time', dates: 'Mar 2021 - Present · 5 yrs 9 mos', location: 'Dubai, United Arab Emirates · Hybrid', present: true },
      { title: 'Growth Marketing Lead', company: 'Swiggy', type: 'Full-time', dates: 'Jan 2018 - Feb 2021 · 3 yrs 2 mos', location: 'Remote' },
    ],
    education: [{ school: 'Indian Institute of Management Bangalore', degree: 'MBA' }],
    skills: [{ name: 'Growth Marketing' }, { name: 'Arabic' }],
  },
];

/** What a correct scraper should return for a profile. */
export function truth(p) {
  return {
    name: p.name,
    headline: p.headline,
    location: p.location,
    degree: p.owner ? null : p.degree,
    about: p.about,
    posts: p.posts,
    jobs: p.jobs.flatMap(j => (j.roles ? j.roles.map(r => ({ title: r.title, company: j.company })) : [{ title: j.title, company: j.company }])),
    schools: p.education.map(e => e.school),
    skills: p.skills.map(s => s.name),
  };
}
