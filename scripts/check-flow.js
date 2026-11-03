// Validates a flow file against WhatsApp limits:  npm run check [-- flows/x.json]
const { loadFlow } = require('../src/flow');
const actions = require('../src/actions');

const file = process.argv[2] || 'flows/faq.json';
try {
  const flow = loadFlow(file, actions);
  console.log(`OK: ${file} (${Object.keys(flow.nodes).length} nodes)`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
