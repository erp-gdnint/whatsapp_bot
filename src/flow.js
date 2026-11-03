const fs = require('fs');
const path = require('path');
const { validateFlow } = require('./validate');

// Loads a flow JSON file and refuses to start if it breaks WhatsApp's rules.
function loadFlow(file, actions) {
  const full = path.resolve(file);
  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read flow file ${full}: ${err.message}`);
  }
  const errors = validateFlow(flow, actions);
  if (errors.length) {
    throw new Error(`Flow file ${full} has ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`);
  }
  return flow;
}

module.exports = { loadFlow };
