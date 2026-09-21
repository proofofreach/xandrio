#!/usr/bin/env python3
"""Freeze source-backed probes before inference. Selection is purposive, not prevalence."""
import pathlib,json,hashlib,datetime
ROOT=pathlib.Path(__file__).resolve().parents[1];D=ROOT/'data/benchmarks/jev-expanded'
def read(b,f='epub'):
 p=D/f'{b}.{f}.extraction.json'
 if not p.exists():p=ROOT/f'data/benchmarks/real-books/{b}.{f}.extraction.json'
 return json.loads(p.read_text())
def digest(s):return hashlib.sha256(s.encode()).hexdigest()
roles=[]
# Labels read from actual source sections, not inferred from the baseline type.
selected={
 ('liberty','epub'):{0:'aux',4:'aux',5:'main',6:'main',7:'aux',8:'main',9:'aux',10:'main',11:'aux',12:'main',13:'rights'},
 ('liberty','mobi'):{0:'rights',1:'aux',5:'main',6:'main',7:'main',9:'aux',11:'aux',12:'main',13:'rights',14:'rights',15:'toc'},
 ('moby','epub'):{0:'toc',1:'aux',2:'main',3:'main',4:'main',5:'main',139:'main',140:'main',141:'rights'},
 ('moby','mobi'):{0:'rights',1:'aux',2:'toc',3:'main',140:'main',141:'main',142:'rights',143:'rights',144:'toc'},
 ('meditations','epub'):{0:'aux',1:'aux',2:'toc',4:'main',5:'main',6:'main',16:'main',18:'aux',19:'aux',20:'rights'},
 ('prince','epub'):{0:'aux',2:'toc',9:'main',10:'main',34:'main',35:'main',36:'main',37:'rights'},
 ('prince','mobi'):{0:'rights',1:'aux',2:'toc',37:'rights',38:'rights',39:'rights',40:'toc'},
 ('sherlock','epub'):{0:'rights',1:'main',2:'main',3:'main',4:'main',14:'main',15:'rights'},
 ('sherlock','mobi'):{0:'rights',1:'aux',2:'aux',3:'toc',4:'main',15:'main',16:'rights',17:'rights',18:'toc'},
 ('souls','epub'):{0:'rights',1:'main',2:'main',15:'main',16:'main',17:'rights'},
 ('souls','mobi'):{0:'rights',1:'aux',2:'toc',3:'main',4:'main',18:'main',19:'rights',20:'rights',21:'toc'},
 ('leaves','epub'):{1:'main',4:'main',23:'main',24:'main',37:'main',125:'main',136:'main',281:'main',286:'main',373:'main',374:'rights'},
}
split=lambda b:'dev' if b in ['souls','leaves','huck'] else 'test'
for (b,f),indices in selected.items():
 doc=read(b,f);cs=doc['import']['chapters']
 for i,gold in indices.items():
  c=cs[i];t=c['text'];base='main' if c['type'] in ['content','chapter'] else 'rights' if c['type']=='copyright' else 'toc' if c['type']=='toc' else 'divider' if c['type']=='divider' else 'aux'
  roles.append(dict(id=f'{b}-{f}-{i}',work=b,format=f,split=split(b),chapterIndex=i,expected=gold,baseline=base,baselineType=c['type'],sourceSha256=doc['sha256'],textSha256=digest(t),state=dict(title=c['title'],text=t[:5000],tail=t[-700:] if len(t)>5000 else '',characters=len(t),previousTitle=cs[i-1]['title'] if i else '',nextTitle=cs[i+1]['title'] if i+1<len(cs) else '')))
# Natural MOBI split in On Liberty, corroborated by the intact source EPUB.
bounds=[]
for b,f,idxs,joins in [('liberty','mobi',[5,6,7,8,9,10,11,12],{7}),('sherlock','mobi',[4,5,6,7,8],set()),('leaves','epub',[4,23,24,125,136,281,286],set())]:
 doc=read(b,f);cs=doc['import']['chapters']
 for i in idxs:
  a,c=cs[i-1:i+1];bounds.append(dict(id=f'{b}-{f}-boundary-{i}',work=b,format=f,split=split(b),chapterIndex=i,expected=i in joins,baseline=False,sourceSha256=doc['sha256'],state=dict(previousTitle=a['title'],previousEnd=a['text'][-2200:],currentTitle=c['title'],currentStart=c['text'][:2200],previousChars=len(a['text']),currentChars=len(c['text']))))
# Every false boundary must remain distinct, including short authored poems and notes.
ref=read('liberty')['import']['chapters'][6]['text'];start=read('liberty','mobi')['import']['chapters'][7]['text'][:250]
assert start in ref
payload=dict(createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),provenance='Agent-adjudicated real source sections; purposive diagnostic sample, not human gold or population estimate. Paired formats stay in same split. Known fixes/obvious markers require deterministic comparator.',roles=roles,boundaries=bounds,thresholds={'choiceConfidence':0.9,'mergeProbability':0.95},boundaryEvidence={'liberty-mobi-boundary-7':{'referenceChapter':6,'referenceOffset':ref.index(start),'referenceFormat':'epub','excerpt':start}})
p=D/'frozen-structure.json';p.write_text(json.dumps(payload,indent=2)) if not p.exists() else (_ for _ in ()).throw(Exception('Frozen output exists'))
print(len(roles),'role probes;',len(bounds),'boundary probes;',digest(p.read_text()))
