'use strict';

const { AddChildNodesCommandBuilder } = require('/commands.js');
const { Dialog, DialogResult } = require('/dialog.js');
const { Document } = require('/document.js');
const { VibranceAdjustmentParameters, VibranceAdjustmentRasterNodeDefinition } = require('/nodes.js');
const { UnitType } = require('/units.js');

const DEFAULT_STRENGTH_PERCENT = 8;

function isOk(result) {
  return (result?.value ?? result) == DialogResult.Ok.value;
}

function buildDialog() {
  const dialog = Dialog.create('APS Color Studio');
  const column = dialog.addColumn();
  const group = column.addGroup('Portrait Natural · Vibrance');
  dialog.strengthControl = group.addUnitValueEditor(
    'Initial strength',
    UnitType.Percent,
    UnitType.Percent,
    DEFAULT_STRENGTH_PERCENT,
    -100,
    100
  ).setPrecision(0);
  dialog.initialWidth = 340;
  return dialog;
}

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

  const dialog = buildDialog();
  if (!isOk(dialog.runModal()))
    return;

  const strength = Math.max(-1, Math.min(1, Number(dialog.strengthControl.value) / 100));
  const parameters = VibranceAdjustmentParameters.create();
  parameters.vibrance = strength;

  const definition = VibranceAdjustmentRasterNodeDefinition.create(parameters);
  definition.userDescription = `APS Color · Vibrance ${Math.round(strength * 100)}%`;

  const builder = AddChildNodesCommandBuilder.create();
  builder.setInsertionTarget(doc.currentSpread);
  builder.addNode(definition);
  doc.executeCommand(builder.createCommand(true));
}

main();
