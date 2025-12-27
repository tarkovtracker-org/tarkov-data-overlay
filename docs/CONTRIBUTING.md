# Contributing to tarkov-data-overlay

Thank you for helping improve Tarkov data accuracy for the community!

## Types of Contributions

### Data Corrections
Fix incorrect data in tarkov.dev (e.g., wrong task levels, incorrect maps).

### Data Additions
Add new data types not available in tarkov.dev (e.g., game editions).

---

## How to Submit a Correction

### 1. Find the Entity ID

Get the tarkov.dev ID for the entity you're correcting:
- **Tasks**: Visit `https://tarkov.dev/task/[task-name]` and find the ID in the URL or page
- **Items**: Visit `https://tarkov.dev/item/[item-name]`
- Or query the API directly

### 2. Gather Proof

You **must** provide proof for every correction:
- Wiki link (preferred): `https://escapefromtarkov.fandom.com/wiki/[Page]`
- In-game screenshot
- Official patch notes

### 3. Edit the Source File

Edit the appropriate file in `src/overrides/`:

```json5
{
  // [Entity Name] - Brief description of what's wrong
  // Proof: [your proof link]
  "<entity-id>": {
    "fieldName": correctValue  // Was: incorrectValue
  }
}
```

### 4. Submit a Pull Request

1. Fork the repository
2. Create a branch: `fix/task-grenadier-level`
3. Make your changes
4. Run `npm run validate` to check your changes
5. Submit a PR using the template

---

## File Format Rules

### Required Comments

Every correction **must** include:

1. **Entity name** as a comment above the ID
2. **Proof link** in the header comment
3. **Original value** as an inline comment

### Example

```json5
{
  // Grenadier - Level requirement incorrect
  // Proof: https://escapefromtarkov.fandom.com/wiki/Grenadier
  // tarkov.dev shows 20, wiki confirms 10
  "5936d90786f7742b1420ba5b": {
    "minPlayerLevel": 10  // Was: 20
  }
}
```

### Field Names

- Use **camelCase** exactly as tarkov.dev does
- `minPlayerLevel` ✅
- `min_player_level` ❌

---

## Patching Nested Data (Objectives)

To patch a specific objective within a task, use the objective's ID as a key:

```json5
{
  // Task Name - Objective count incorrect
  // Proof: [link]
  "task-id-here": {
    "objectives": {
      "objective-id-here": {
        "count": 4  // Was: 3
      }
    }
  }
}
```

You can also patch objective item lists (for TaskObjectiveItem objectives) by
providing an `items` array:

```json5
{
  // Task Name - Missing objective items
  // Proof: [link]
  "task-id-here": {
    "objectives": {
      "objective-id-here": {
        "items": [
          { "id": "item-id-1", "name": "Item Name 1" },
          { "id": "item-id-2", "name": "Item Name 2" }
        ]
      }
    }
  }
}
```

If tarkov.dev is missing the objective entirely, add it using `objectivesAdd`:

```json5
{
  // Task Name - Missing objective in API
  // Proof: [link]
  "task-id-here": {
    "objectivesAdd": [
      {
        "description": "Find in raid",
        "items": [
          { "name": "Item Name 1" },
          { "name": "Item Name 2", "id": "item-id-2" }
        ]
      }
    ]
  }
}
```

---

## Local Development

```bash
# Install dependencies
npm install

# Validate your changes
npm run validate

# Build the overlay locally
npm run build
```

---

## Questions?

Open an issue or reach out on Discord.
