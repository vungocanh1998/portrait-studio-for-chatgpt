'use strict';

const { AddChildNodesCommandBuilder, CompoundCommandBuilder } = require('/commands.js');
const { Document } = require('/document.js');
const { ContainerNodeDefinition } = require('/nodes.js');

const WORKFLOW_GROUP = 'APS Retouch Workflow · Manual';
const STEPS = [
  '01 · Cleanup — add Pixel Layer manually',
  '02 · Dodge & Burn — add Pixel Layers manually',
  '03 · Texture Detail — add Pixel Layer manually'
];

function main() {
  const doc = Document.current;
  if (!doc) {
    alert('Open a saved .afphoto working copy first.');
    return;
  }

  if (!/\.afphoto$/i.test(String(doc.path || ''))) {
    alert('For source safety, this script only edits a saved .afphoto working copy. Save a separate copy in Affinity first.');
    return;
  }

  const parent = AddChildNodesCommandBuilder.create();
  parent.setInsertionTarget(doc.currentSpread);
  parent.addNode(ContainerNodeDefinition.create(WORKFLOW_GROUP));

  const children = AddChildNodesCommandBuilder.create();
  for (const name of STEPS)
    children.addNode(ContainerNodeDefinition.create(name));

  const command = CompoundCommandBuilder.create()
    .addCommand(parent.createCommand(true))
    .addCommand(children.createCommand(false))
    .createCommand();
  doc.executeCommand(command);
}

main();
