import { describe, it, expect } from 'vitest';
import { exportFrom } from '../helpers/load.js';

const CommonGround = exportFrom('utils/common-ground.js', 'CommonGround');

const me = {
  name: 'Rahul Sharma',
  location: 'Dublin, County Dublin, Ireland',
  currentCompany: 'Accenture',
  pastCompanies: ['Infosys Ltd.'],
  educationEntries: ['Trinity College Dublin — MSc Data Science', 'NIT Trichy — B.Tech'],
  skills: ['Python', 'SQL', 'Tableau'],
};

const them = {
  name: 'Aoife Murphy',
  location: 'Dublin, County Dublin, Ireland',
  currentCompany: 'Spotify',
  pastCompanies: ['Accenture'],
  educationEntries: ['Trinity College Dublin — MSc Computer Science'],
  skills: ['Python', 'SQL', 'Recommender Systems'],
};

describe('common ground', () => {
  it('finds a shared school, employer, city and skills, strongest first', () => {
    expect(CommonGround.find(me, them).map((i) => i.label)).toEqual([
      'You both studied at Trinity College Dublin',
      'You both worked at Accenture',
      'You are both in Dublin',
      'Shared skills: Python, SQL',
    ]);
  });

  it('matches companies despite "Ltd", "Pvt" and the like', () => {
    const items = CommonGround.find(me, { ...them, pastCompanies: ['Infosys Limited'] });
    expect(items.map((i) => i.kind)).toContain('company');
  });

  it('same country, different city', () => {
    const items = CommonGround.find(me, { ...them, location: 'Cork, County Cork, Ireland', educationEntries: [], pastCompanies: [], skills: [] });
    expect(items).toEqual([expect.objectContaining({ kind: 'country', label: 'You are both in Ireland' })]);
  });

  it('both studied in India: a real bond for students abroad', () => {
    const items = CommonGround.find(me, {
      name: 'Priya Nair', location: 'Berlin, Germany',
      educationEntries: ['IIT Madras — B.Tech Computer Science', 'TU Munich — MSc Informatics'],
    });
    expect(items).toEqual([expect.objectContaining({ kind: 'roots', strength: 2, label: 'You both studied in India' })]);
  });

  it('nothing in common gives an empty list, not a forced match', () => {
    expect(CommonGround.find(me, { name: 'Lena Fischer', location: 'Hamburg, Germany', educationEntries: ['Universität Hamburg — BSc'] })).toEqual([]);
  });

  it('by default the writer gets the strong ones, at most two', () => {
    expect(CommonGround.defaultPick(CommonGround.find(me, them))).toEqual([
      'We both studied at Trinity College Dublin',
      'We have both worked at Accenture',
    ]);
  });

  it('a shared city is offered, but not picked by default: alone, it is not personal', () => {
    const cityOnly = { ...them, educationEntries: [], pastCompanies: [], skills: [] };
    expect(CommonGround.find(me, cityOnly)).toEqual([expect.objectContaining({ kind: 'city', label: 'You are both in Dublin' })]);
    expect(CommonGround.defaultPick(CommonGround.find(me, cityOnly))).toEqual([]);
    // Next to a shared school, it is not picked either.
    expect(CommonGround.defaultPick(CommonGround.find(me, { ...cityOnly, educationEntries: them.educationEntries }))).toEqual([
      'We both studied at Trinity College Dublin',
    ]);
  });

  it('works without an imported profile', () => {
    expect(CommonGround.find(null, them)).toEqual([]);
  });
});
