#!/usr/bin/env python3
"""Authored verification probes over real excerpts. Not naturally occurring guide errors."""
import json,pathlib,hashlib,datetime
R=pathlib.Path(__file__).resolve().parents[1];D=R/'data/benchmarks/jev-expanded'
# Each evidence slice has two supported paraphrases and two deliberate failures.
specs=[
('meditations',5,1700,['Marcus credits his grandfather Verus with teaching him gentleness.','Marcus says his mother taught him to be generous and content with a spare diet.','Marcus credits Diognetus with teaching him a spare diet.','Marcus says his mother taught him that great wealth was necessary for happiness.']),
('meditations',6,1700,['The passage urges the reader to perform actions with justice.','The passage warns that the allotted time can pass without returning.','The passage says time lost to delay can always be recovered later.','The passage promises that justice will make every person wealthy.']),
('prince',9,2000,['The author distinguishes republics from principalities.','Principalities can be hereditary or new.','The author says all states are republics.','All new principalities must be acquired exclusively by the prince’s own armed forces.']),
('prince',10,2500,['The author considers hereditary states easier to retain than new ones.','An extraordinary and excessive force can deprive even a hereditary prince of his state.','Hereditary princes can never be deprived of their states.','The author considers new states easier to retain than hereditary states.']),
('souls',1,2289,['Du Bois calls the color line the problem of the twentieth century.','The author describes two chapters about Emancipation and its aftermath.','The author says the problem of the twentieth century is solely poverty.','The author describes exactly five chapters devoted to Emancipation and its aftermath.']),
('souls',2,1800,['People often approach the narrator indirectly instead of asking how it feels to be a problem.','The narrator says he seldom answers the real question with a word.','The narrator says everyone always asks the real question directly.','The narrator always gives a long spoken answer to the real question.']),
('liberty',5,1900,['The essay concerns Civil or Social Liberty rather than liberty of the will.','The essay examines the limits of society’s legitimate power over individuals.','The essay primarily defends metaphysical free will against Philosophical Necessity.','The author says the struggle between Liberty and Authority first began in the twentieth century.']),
('liberty',8,2200,['The author distinguishes freedom of action from freedom of opinion.','An opinion may lose immunity when its expression instigates a harmful act.','The author claims actions must always be as unrestricted as opinions.','The author says an opinion about corn-dealers must be punished even when merely circulated through the press.']),
('darwin',5,2400,['Darwin says he enlarged his earlier notes into a sketch in 1844.','Wallace had reached almost the same general conclusions on the origin of species.','Darwin says his sketch was enlarged in 1837.','Wallace had reached conclusions that were the exact opposite of Darwin’s.']),
('darwin',6,2050,['Darwin says domesticated varieties generally vary more among individuals than those in nature.','Darwin treats excess food as a possible partial contributor to variability.','Darwin proves that excess food is the sole cause of all variability.','Darwin says cultivated wheat has ceased producing new varieties.']),
('walden',3,2100,['Thoreau says he lived at Walden for two years and two months.','Thoreau says the house on Walden Pond’s shore was one he had built himself.','Thoreau says he lived at Walden for exactly two months.','Thoreau says he rented his Walden house from his nearest neighbor.']),
('walden',4,1900,['Thoreau describes buying farms in his imagination.','Thoreau says he withdrew and left each farmer to carry on farming.','Thoreau says he received legal deeds to every farm he imagined buying.','Thoreau says his imaginary purchases required all farmers to leave their land.']),
]
rows=[]
for book,idx,n,claims in specs:
 p=D/f'{book}.epub.extraction.json'
 if not p.exists():p=R/f'data/benchmarks/real-books/{book}.epub.extraction.json'
 doc=json.loads(p.read_text());text=doc['import']['chapters'][idx]['text'];evidence=text[:n]
 for j,statement in enumerate(claims):rows.append(dict(id=f'{book}-{idx}-{j}',work=book,split='dev' if book in ['souls','darwin','walden'] else 'test',sourceSha256=doc['sha256'],chapterIndex=idx,evidence=evidence,evidenceOffset=0,evidenceSha256=hashlib.sha256(evidence.encode()).hexdigest(),statement=statement,expected=j<2,origin='Agent-authored supported paraphrase' if j<2 else 'Deliberately authored unsupported mutation'))
out=D/'frozen-verification.json'
with out.open('x') as f:json.dump(dict(createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),scope='48 controlled probes, six real nonfiction sources; not human gold, not production error prevalence, not 200-claim certification',thresholds={'acceptProbability':0.95,'rejectProbability':0.05},rows=rows),f,indent=2)
print(len(rows))
