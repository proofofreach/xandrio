#!/usr/bin/env python3
# Operational eligibility is EVERY adjacent pair in a previously unqueried book.
import pathlib,json,datetime,hashlib
D=pathlib.Path(__file__).resolve().parents[1]/'data/benchmarks/jev-expanded';rows=[]
for fmt,joins,tocindex in [('epub',{9,11,13,15},6),('mobi',{6,9,12},3)]:
 d=json.loads((D/f'carol.{fmt}.extraction.json').read_text());cs=d['import']['chapters'];found=next(i for i,c in enumerate(cs) if c.get('type')=='toc');assert found==tocindex;toc=cs[found]['text']
 for i in range(1,len(cs)):
  a,c=cs[i-1:i+1];rows.append(dict(id=f'carol-{fmt}-boundary-{i}',work='carol',format=fmt,split='operational-unseen',chapterIndex=i,expected=i in joins,baseline=False,sourceSha256=d['sha256'],state=dict(authoredContents=toc,previousTitle=a['title'],previousEnd=a['text'][-2200:],currentTitle=c['title'],currentStart=c['text'][:2200],previousChars=len(a['text']),currentChars=len(c['text']))))
# Front-matter fragments are intentionally kept separate; task is authored narrative chapter continuity.
with (D/'frozen-operational.json').open('x') as f:json.dump(dict(createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),eligibility='All adjacent section pairs, no oracle-selected candidates; preserve separate frontmatter/notes. Freeze before model inference.',roles=[],boundaries=rows,thresholds={'choiceConfidence':0.9,'mergeProbability':0.95},reference='Original in-book contents lists five staves. Four EPUB and three MOBI boundaries split those staves at illustrations or parser chunks.'),f,indent=2)
print(len(rows))
