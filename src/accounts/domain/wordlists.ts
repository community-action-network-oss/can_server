// Curated, calm, neutral words for handles. Lowercase ascii, 3-8 letters.
// No names, places, politics, religion, body or slur-adjacent words.
const words = (s: string): readonly string[] => s.trim().split(/\s+/);

export const ADJECTIVES = words(`
calm quiet gentle steady bright warm kind clear fresh soft swift patient honest humble brave bold
cheerful clever cozy crisp curious eager earnest easy even fair faithful fine firm fond friendly
frank gleaming glad golden good graceful grand happy hardy hearty helpful hopeful jolly keen
lively loyal lucky merry mild modest neat nimble noble open orderly plain playful polite proud
prompt pure radiant ready regular restful rustic sensible serene settled sharp shiny silver
simple sincere smooth snug solid sound spry sturdy subtle sunny sweet tidy tranquil trusty
upbeat useful vivid wise witty zesty amber balanced breezy careful casual civil composed
content dapper daring decent direct dutiful elegant fluent focused genial gifted glowing
hushed ideal jaunty lasting lucid mellow mindful natural normal rested rounded sandy savvy
spirited stable sterling supple tender thankful thriving timely unified verdant vibrant
willing woolly youthful zealous
`);

export const NOUNS = words(`
river meadow pebble lantern willow maple cedar falcon otter heron sparrow robin finch wren
swan crane lark thrush badger beaver rabbit squirrel fox deer moose bison lynx marten ferret
mole hedgehog acorn birch aspen elm oak pine spruce juniper clover fern moss ivy reed rush
sedge thistle daisy lily tulip violet poppy orchid lotus bloom petal leaf branch twig root
seed sprout garden orchard grove forest brook creek stream pond lake spring cloud breeze
rain mist dew frost snow comet star planet orbit ember flame spark candle lamp kettle teapot
basket bucket ladder bridge anchor compass kite sail oar canoe boat wagon cart wheel gear
bell chime drum flute harp fiddle piano whistle quilt blanket pillow cushion button thimble
needle thread ribbon marble crystal pearl coral quartz granite slate cobble tile brick
timber barn cabin cottage porch window door gate fence path trail lane bench table chair
shelf book page ink quill pencil paper map atlas journal letter
`);
