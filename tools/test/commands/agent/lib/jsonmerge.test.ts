import { describe, expect, it } from 'vitest';
import { mergeCsvRows, mergeJson } from '../../../../src/commands/agent/lib/jsonmerge.ts';

describe('mergeJson', () => {
  it('takes the side that changed a key, merges objects inside, and names a key both changed differently', () => {
    const base = { a: 1, keep: true, schema: { properties: { a: {} } } };
    const ours = { a: 1, keep: true, b: 2, schema: { properties: { a: {}, b: { type: 'integer' } } } };
    const theirs = { a: 1, c: 3, schema: { properties: { a: {}, c: { type: 'string' } } } };
    expect(mergeJson(base, ours, theirs)).toEqual({
      value: { a: 1, b: 2, schema: { properties: { a: {}, b: { type: 'integer' }, c: { type: 'string' } } }, c: 3 },
    });
    expect(mergeJson({ a: 1 }, { a: 2 }, { a: 2 })).toEqual({ value: { a: 2 } });
    expect(mergeJson({ a: 1 }, { a: 2 }, { a: 3 })).toEqual({ conflict: 'a' });
    expect(mergeJson({ x: { y: 1 } }, { x: { y: 2 } }, { x: { y: 3 } })).toEqual({ conflict: 'x.y' });
    expect(mergeJson({}, { a: [1] }, { a: [2] })).toEqual({ conflict: 'a' });
    expect(mergeJson(1, 2, 3)).toEqual({ conflict: '(root)' });
    // a JSON schema required list: both sides' additions, without what either side removed
    expect(mergeJson({ required: ['a', 'b'] }, { required: ['a', 'b', 'c'] }, { required: ['b', 'd'] }, { schema: true })).toEqual({ value: { required: ['b', 'c', 'd'] } });
    // outside a JSON schema a `required` key holds a value, not a name list
    expect(mergeJson({ required: ['a'] }, { required: ['a', 'b'] }, { required: ['c'] })).toEqual({ conflict: 'required' });
    // a core settings key ending in `.required` holds a value, not a schema name list
    expect(mergeJson({ 'consent.required': ['terms'] }, { 'consent.required': ['terms', 'age'] }, { 'consent.required': [] })).toEqual({ conflict: 'consent.required' });
    expect(mergeJson({ 'consent.required': ['terms'] }, { 'consent.required': ['terms', 'age'] }, { 'consent.required': [] }, { schema: true })).toEqual({ conflict: 'consent.required' });
    expect(mergeJson({ list: ['a'] }, { list: ['a', 'b'] }, { list: ['a', 'c'] })).toEqual({ conflict: 'list' });
  });
});

describe('mergeCsvRows', () => {
  it('keeps the rows either side added, drops the rows either side removed, and puts every column on one header', () => {
    const base = 'id,name\n[a],A\n[b],B\n';
    const ours = 'id,name\n[a],A\n[b],B\n[c],"C, c"\n';
    const theirs = 'id,name\n[a],A\n[d],D\n';
    expect(mergeCsvRows(base, ours, theirs)).toEqual({ text: 'id,name\n[a],A\n[c],"C, c"\n[d],D\n' });
    // a column one side added: the rows of the other side get an empty cell there
    expect(mergeCsvRows(base, 'id,name,ko\n[a],A,에이\n[b],B,\n', `${base}[f],F\n`)).toEqual({ text: 'id,name,ko\n[a],A,에이\n[b],B,\n[f],F,\n' });
    // a data table: a 4-row header named by its last row, whose descriptions may repeat
    const h = ',,\nAll,All,Server\nid(key),int,int\nid,amount,weight\n';
    expect(mergeCsvRows(`${h}[a],1,10\n`, `${h}[a],1,10\n[b],2,20\n`, `${h}[a],1,10\n[c],3,30\n`, 4)).toEqual({ text: `${h}[a],1,10\n[b],2,20\n[c],3,30\n` });
    const wider = ',,,\nAll,All,Server,All\nid(key),int,int,string\nid,amount,weight,label\n';
    expect(mergeCsvRows(`${h}[a],1,10\n`, `${wider}[a],1,10,A\n`, `${h}[a],1,10\n[c],3,30\n`, 4)).toEqual({ text: `${wider}[a],1,10,A\n[c],3,30,\n` });
    expect(mergeCsvRows(h, ',\n,\n,\nid,id\n', h, 4)).toEqual({ conflict: 'a header names a column twice' });
    // a header cell one side changed is kept; both changing it differently is a conflict
    const allTargets = ',,\nAll,All,All\nid(key),int,int\nid,amount,weight\n';
    expect(mergeCsvRows(`${h}[a],1,10\n`, `${h}[a],1,10\n[b],2,20\n`, `${allTargets}[a],1,10\n[c],3,30\n`, 4)).toEqual({ text: `${allTargets}[a],1,10\n[b],2,20\n[c],3,30\n` });
    const clientWeight = ',,\nAll,All,Client\nid(key),int,int\nid,amount,weight\n';
    expect(mergeCsvRows(h, clientWeight, allTargets, 4)).toEqual({ conflict: 'the header of column weight changed on both sides' });
    // a side that removed or renamed a column of base: a conflict, both ways
    const noWeight = ',\nAll,All\nid(key),int\nid,amount\n';
    expect(mergeCsvRows(`${h}[a],1,10\n`, `${noWeight}[a],1\n`, `${h}[a],1,10\n[c],3,30\n`, 4)).toEqual({ conflict: 'a side removed or renamed the column weight' });
    expect(mergeCsvRows(`${h}[a],1,10\n`, `${h}[a],1,10\n[c],3,30\n`, `${noWeight}[a],1\n`, 4)).toEqual({ conflict: 'a side removed or renamed the column weight' });
    // both sides added the same key with different rows
    expect(mergeCsvRows(h, `${h}[e],1,1\n`, `${h}[e],2,2\n`, 4)).toEqual({ conflict: 'both sides have a row of key [e]' });
    // both sides add the same row: it goes in once
    expect(mergeCsvRows(base, `${base}[e],E\n`, `${base}[e],E\n`)).toEqual({ text: `${base}[e],E\n` });
  });
});
