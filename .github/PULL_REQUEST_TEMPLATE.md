## Description

<!-- Brief description of the changes -->

## Type of Change

<!-- Check all that apply -->

- [ ] Data correction (fixing incorrect tarkov.dev data)
- [ ] New data addition (data not in tarkov.dev)
- [ ] Schema update
- [ ] Documentation update
- [ ] Build/tooling update

## Proof of Correctness

<!-- Required for data corrections - link to wiki, screenshot, or other evidence -->

## Checklist

- [ ] I have included proof links in the JSON5 comments
- [ ] I have noted the original incorrect value in inline comments
- [ ] I have included the entity name as a comment above each ID
- [ ] Field names match tarkov.dev schema exactly (camelCase)
- [ ] Validation passes locally (`npm run validate`)
- [ ] Type-check and tests pass when relevant (`npm run typecheck`, `npm test`)
- [ ] For data changes, I ran `npm run build` and committed the regenerated `dist/overlay.json`

## Commands Run

<!--
List the commands you ran and their result, e.g.
`npm run validate` ✅ · `npm run build` ✅ (regenerated dist/overlay.json) · `npm run typecheck` ✅ · `npm test` ✅
-->

## Related Issues

<!-- Link any related issues -->

Closes #
