# Master Samples

Comprehensive, copy-paste JSON5 examples that cover every field supported by this repo's schemas.

Legend (TarkovTracker):
- `UI`: Rendered in the app.
- `UI (logic)`: Used by app logic (filters, dependency graph, map markers), but not necessarily shown directly.
- `Console-only`: Present in task/objective data but not used/rendered by the app.

---

## Tasks

Notes:
- Do not use a task-level `maps` field for new data. Use `task.map` and `objectives[].maps` instead.

### Task Override (all fields)

```json5
{
  // Sample Task - Override (all fields)
  // Proof: [link]
  "task-id-1": {
    name: "Task Name 1", // Optional | UI
    wikiLink: "https://escapefromtarkov.fandom.com/wiki/Task_Name_1", // Optional | UI
    map: { id: "map-id-1", name: "Map Name 1" }, // Optional | UI
    minPlayerLevel: 20, // Optional | UI
    factionName: "USEC", // Optional | UI (logic); allowed: "Any" | "USEC" | "BEAR"
    kappaRequired: false, // Optional | UI (logic)
    lightkeeperRequired: false, // Optional | UI (logic)
    requiredPrestige: {
      id: "prestige-id-1",
      name: "Prestige Name 1",
      prestigeLevel: 1,
    }, // Optional | Console-only; reserved for future UI/logic (no current TT usage found)
    experience: 8000, // Optional | UI
    disabled: false, // Optional | UI (logic); when true, task is filtered out of task lists
    taskRequirements: [
      {
        task: { id: "task-id-prereq-1", name: "Prereq Task 1" }, // Required | UI (logic) when entry exists
        status: ["complete"], // Optional | UI (logic); allowed: "accepted" | "active" | "complete" | "completed" | "failed"
      },
    ], // Optional | UI (logic); used by the dependency graph (previous/next tasks)
    traderRequirements: [
      {
        trader: { id: "trader-id-1", name: "Trader Name 1" }, // Required | Console-only when entry exists
        value: 2, // Required | Console-only (0-4)
        compareMethod: ">=", // Optional | Console-only; likely one of: ">" | ">=" | "=" | "<=" | "<" (not schema-enforced)
      },
    ], // Optional | Console-only
    startRewards: {
      items: [
        {
          count: 3000, // Required | Console-only when entry exists
          item: {
            id: "item-id-1",
            name: "Item Name 1",
            shortName: "Item Shortname 1",
          }, // Required | Console-only when entry exists (id + name required)
        },
      ],
      traderStanding: [
        {
          trader: { id: "trader-id-1", name: "Trader Name 1" }, // Required | Console-only when entry exists
          standing: 0.01, // Required | Console-only when entry exists
        },
      ],
      offerUnlock: [
        {
          trader: { id: "trader-id-1", name: "Trader Name 1" }, // Required | Console-only when entry exists
          level: 2, // Required | Console-only when entry exists
          item: {
            id: "item-id-2",
            name: "Item Name 2",
            shortName: "Item Shortname 2",
          }, // Required | Console-only when entry exists (id + name required)
        },
      ],
      skillLevelReward: [
        {
          name: "Skill Name 1", // Required | Console-only when entry exists
          level: 1, // Required | Console-only when entry exists
          skill: {
            id: "skill-id-1",
            name: "Skill Name 1",
            imageLink: "https://example.com/skill-1.png",
          }, // Optional | Console-only (id + name required if provided)
        },
      ],
      traderUnlock: { id: "trader-unlock-id-1", name: "Trader Unlock Name 1" }, // Optional | Console-only
    }, // Optional | Console-only
    finishRewards: {
      items: [
        {
          count: 1, // Required | UI when entry exists
          item: {
            id: "item-id-3",
            name: "Item Name 3",
            shortName: "Item Shortname 3",
          }, // Required | UI when entry exists (id + name required)
        },
      ],
      traderStanding: [
        {
          trader: { id: "trader-id-1", name: "Trader Name 1" }, // Required | UI when entry exists
          standing: 0.02, // Required | UI when entry exists
        },
      ],
      offerUnlock: [
        {
          trader: { id: "trader-id-1", name: "Trader Name 1" }, // Required | UI when entry exists
          level: 2, // Required | UI when entry exists
          item: {
            id: "item-id-2",
            name: "Item Name 2",
            shortName: "Item Shortname 2",
          }, // Required | UI when entry exists (id + name required)
        },
      ],
      skillLevelReward: [
        {
          name: "Skill Name 2", // Required | UI when entry exists
          level: 2, // Required | UI when entry exists
          skill: {
            id: "skill-id-2",
            name: "Skill Name 2",
            imageLink: "https://example.com/skill-2.png",
          }, // Optional | UI (shown as name even if skill object is missing)
        },
      ],
      traderUnlock: { id: "trader-unlock-id-2", name: "Trader Unlock Name 2" }, // Optional | UI
    }, // Optional | UI
    objectives: {
      "objective-id-1": {
        description: "Objective Description 1.", // Optional | UI
        type: "plantItem", // Optional | UI (logic); map view filtering recognizes: "mark" | "zone" | "extract" | "visit" | "findItem" | "findQuestItem" | "plantItem" | "plantQuestItem" | "shoot"
        maps: [{ id: "map-id-1", name: "Map Name 1" }], // Optional | UI (logic)
        items: [
          {
            id: "item-id-4",
            name: "Item Name 4",
            shortName: "Item Shortname 4",
          },
        ], // Optional | UI (logic)
        count: 1, // Optional | UI (logic)
        foundInRaid: false, // Optional | UI (logic)
        requiredKeys: [
          [
            {
              id: "key-id-1",
              name: "Key Name 1",
              shortName: "Key Shortname 1",
            },
          ],
        ], // Optional | Console-only
        optional: true, // Optional | Console-only
        zones: [
          {
            map: { id: "map-id-1", name: "Map Name 1" }, // Required | UI (logic) when entry exists
            outline: [
              { x: 300.1, z: -100.2 },
              { x: 250.3, z: -70.4 },
              { x: 220.5, z: -120.6 },
            ], // Optional | UI (logic); min 3 points required to render polygon (more points allowed)
            position: { x: 260.7, z: -110.8 }, // Optional | UI (logic); point marker if outline is missing/too small
            top: 26, // Optional | Console-only
            bottom: 24, // Optional | Console-only
          },
        ], // Optional | UI (logic)
        possibleLocations: [
          {
            map: { id: "map-id-1", name: "Map Name 1" }, // Required | UI (logic) when entry exists
            positions: [{ x: 245.9, z: -130.1 }], // Required | UI (logic) when entry exists
          },
        ], // Optional | UI (logic)
      },
      "objective-id-2": {
        description: "Objective Description 2.",
        type: "shoot", // Optional | UI (logic); map view filtering recognizes: "mark" | "zone" | "extract" | "visit" | "findItem" | "findQuestItem" | "plantItem" | "plantQuestItem" | "shoot"
        maps: [{ id: "map-id-1", name: "Map Name 1" }],
        count: 10,
        useAny: [
          { id: "item-id-5", name: "Item Name 5", shortName: "Item Shortname 5" },
          { id: "item-id-6", name: "Item Name 6", shortName: "Item Shortname 6" },
        ], // Optional | Console-only
        usingWeapon: [
          { id: "item-id-7", name: "Item Name 7", shortName: "Item Shortname 7" },
        ], // Optional | Console-only
        usingWeaponMods: [
          [
            { id: "item-id-8", name: "Item Name 8", shortName: "Item Shortname 8" },
          ],
        ], // Optional | Console-only
        wearing: [
          { id: "item-id-9", name: "Item Name 9", shortName: "Item Shortname 9" },
        ], // Optional | Console-only
        notWearing: [
          { id: "item-id-10", name: "Item Name 10", shortName: "Item Shortname 10" },
        ], // Optional | Console-only
        distance: 65, // Optional | Console-only
        minDurability: 40, // Optional | Console-only
        maxDurability: 85, // Optional | Console-only
        timeFromHour: 2, // Optional | Console-only
        timeUntilHour: 6, // Optional | Console-only
      },
      "objective-id-3": {
        description: "Objective Description 3.",
        type: "findQuestItem", // Optional | UI (logic); map view filtering recognizes: "mark" | "zone" | "extract" | "visit" | "findItem" | "findQuestItem" | "plantItem" | "plantQuestItem" | "shoot"
        maps: [{ id: "map-id-1", name: "Map Name 1" }],
        item: { id: "item-id-11", name: "Item Name 11", shortName: "Item Shortname 11" }, // Optional | UI (logic)
        questItem: {
          id: "item-id-12",
          name: "Item Name 12",
          shortName: "Item Shortname 12",
        }, // Optional | UI (logic)
        markerItem: {
          id: "item-id-13",
          name: "Item Name 13",
          shortName: "Item Shortname 13",
        }, // Optional | UI (logic)
        containsAll: [
          { id: "item-id-14", name: "Item Name 14", shortName: "Item Shortname 14" },
          { id: "item-id-15", name: "Item Name 15", shortName: "Item Shortname 15" },
        ], // Optional | Console-only
      },
    },
    objectivesAdd: [
      {
        id: "objective-id-missing-1", // Required | UI (logic) when entry exists
        description: "Objective Description Missing 1.", // Required | UI (logic) when entry exists
        type: "findItem", // Optional | UI (logic); map view filtering recognizes: "mark" | "zone" | "extract" | "visit" | "findItem" | "findQuestItem" | "plantItem" | "plantQuestItem" | "shoot"
        items: [
          { name: "Item Name 16" }, // Required | UI (logic) when entry exists (name-only is allowed in objectivesAdd)
          { id: "item-id-16", name: "Item Name 16" },
        ], // Optional | UI (logic)
        count: 1, // Optional | UI (logic)
      },
    ], // Optional | UI (logic); overlay appends this into objectives and does not return objectivesAdd as-is
  },
}
```

### Task Addition (all fields)

```json5
{
  // Sample Task - Addition (all fields)
  // Proof: [link]
  task_key_1: {
    id: "task_key_1", // Required | UI (logic); should match key
    name: "Task Name 2", // Required | UI
    wikiLink: "https://escapefromtarkov.fandom.com/wiki/Task_Name_2", // Required | UI
    trader: { id: "trader-id-2", name: "Trader Name 2" }, // Required | UI; include trader.id to allow app to merge in icon/image
    map: { id: "map-id-1", name: "Map Name 1" }, // Optional | UI
    kappaRequired: false, // Optional | UI (logic)
    lightkeeperRequired: false, // Optional | UI (logic)
    factionName: "Any", // Optional | UI (logic); allowed: "Any" | "USEC" | "BEAR"
    minPlayerLevel: 15, // Optional | UI
    requiredPrestige: {
      id: "prestige-id-1",
      name: "Prestige Name 1",
      prestigeLevel: 1,
    }, // Optional | Console-only; reserved for future UI/logic (no current TT usage found)
    experience: 5000, // Optional | UI
    disabled: false, // Optional | UI (logic); when true, task is filtered out before it reaches the UI
    taskRequirements: [
      {
        task: { id: "task-id-prereq-2", name: "Prereq Task 2" }, // Required | UI (logic) when entry exists
        status: ["complete"], // Optional | UI (logic); allowed: "accepted" | "active" | "complete" | "completed" | "failed"
      },
    ], // Optional | UI (logic)
    traderRequirements: [
      {
        trader: { id: "trader-id-2", name: "Trader Name 2" }, // Required | Console-only when entry exists
        value: 2, // Required | Console-only (0-4)
        compareMethod: ">=", // Optional | Console-only; likely one of: ">" | ">=" | "=" | "<=" | "<" (not schema-enforced)
      },
    ], // Optional | Console-only
    startRewards: {
      items: [
        {
          count: 3000, // Required | Console-only when entry exists
          item: { id: "item-id-1", name: "Item Name 1", shortName: "Item Shortname 1" }, // Required | Console-only when entry exists (id + name required)
        },
      ],
      traderStanding: [
        {
          trader: { id: "trader-id-2", name: "Trader Name 2" }, // Required | Console-only when entry exists
          standing: 0.01, // Required | Console-only when entry exists
        },
      ],
      offerUnlock: [
        {
          trader: { id: "trader-id-2", name: "Trader Name 2" }, // Required | Console-only when entry exists
          level: 2, // Required | Console-only when entry exists
          item: { id: "item-id-2", name: "Item Name 2", shortName: "Item Shortname 2" }, // Required | Console-only when entry exists (id + name required)
        },
      ],
      skillLevelReward: [
        {
          name: "Skill Name 1", // Required | Console-only when entry exists
          level: 1, // Required | Console-only when entry exists
          skill: {
            id: "skill-id-1",
            name: "Skill Name 1",
            imageLink: "https://example.com/skill-1.png",
          },
        },
      ],
      traderUnlock: { id: "trader-unlock-id-1", name: "Trader Unlock Name 1" }, // Optional | Console-only
    }, // Optional | Console-only
    finishRewards: {
      items: [
        {
          count: 1, // Required | UI when entry exists
          item: { id: "item-id-3", name: "Item Name 3", shortName: "Item Shortname 3" }, // Required | UI when entry exists (id + name required)
        },
      ],
      traderStanding: [
        {
          trader: { id: "trader-id-2", name: "Trader Name 2" }, // Required | UI when entry exists
          standing: 0.02, // Required | UI when entry exists
        },
      ],
      offerUnlock: [
        {
          trader: { id: "trader-id-2", name: "Trader Name 2" }, // Required | UI when entry exists
          level: 2, // Required | UI when entry exists
          item: { id: "item-id-2", name: "Item Name 2", shortName: "Item Shortname 2" }, // Required | UI when entry exists (id + name required)
        },
      ],
      skillLevelReward: [
        {
          name: "Skill Name 2", // Required | UI when entry exists
          level: 2, // Required | UI when entry exists
          skill: {
            id: "skill-id-2",
            name: "Skill Name 2",
            imageLink: "https://example.com/skill-2.png",
          },
        },
      ],
      traderUnlock: { id: "trader-unlock-id-2", name: "Trader Unlock Name 2" }, // Optional | UI
    }, // Optional | UI
    objectives: [
      {
        id: "objective-id-4", // Required | UI (logic)
        description: "Objective Description 4.", // Required | UI
        type: "plantItem", // Optional | UI (logic); map view filtering recognizes: "mark" | "zone" | "extract" | "visit" | "findItem" | "findQuestItem" | "plantItem" | "plantQuestItem" | "shoot"
        maps: [{ id: "map-id-1", name: "Map Name 1" }], // Optional | UI (logic)
        items: [
          {
            id: "item-id-4",
            name: "Item Name 4",
            shortName: "Item Shortname 4",
          },
        ], // Optional | UI (logic)
        count: 1, // Optional | UI (logic)
        foundInRaid: false, // Optional | UI (logic)
        requiredKeys: [
          [
            {
              id: "key-id-1",
              name: "Key Name 1",
              shortName: "Key Shortname 1",
            },
          ],
        ], // Optional | Console-only
        optional: true, // Optional | Console-only
        zones: [
          {
            map: { id: "map-id-1", name: "Map Name 1" }, // Required | UI (logic) when entry exists
            outline: [
              { x: 300.1, z: -100.2 },
              { x: 250.3, z: -70.4 },
              { x: 220.5, z: -120.6 },
            ], // Optional | UI (logic); min 3 points required to render polygon
            position: { x: 260.7, z: -110.8 }, // Optional | UI (logic)
            top: 26, // Optional | Console-only
            bottom: 24, // Optional | Console-only
          },
        ],
        possibleLocations: [
          {
            map: { id: "map-id-1", name: "Map Name 1" }, // Required | UI (logic) when entry exists
            positions: [{ x: 245.9, z: -130.1 }], // Required | UI (logic) when entry exists
          },
        ],
      },
      {
        id: "objective-id-5", // Required | UI (logic)
        description: "Objective Description 5.", // Required | UI
        type: "shoot", // Optional | UI (logic); map view filtering recognizes: "mark" | "zone" | "extract" | "visit" | "findItem" | "findQuestItem" | "plantItem" | "plantQuestItem" | "shoot"
        maps: [{ id: "map-id-1", name: "Map Name 1" }], // Optional | UI (logic)
        count: 10, // Optional | UI (logic)
        useAny: [
          { id: "item-id-5", name: "Item Name 5", shortName: "Item Shortname 5" },
          { id: "item-id-6", name: "Item Name 6", shortName: "Item Shortname 6" },
        ], // Optional | Console-only
        usingWeapon: [
          { id: "item-id-7", name: "Item Name 7", shortName: "Item Shortname 7" },
        ], // Optional | Console-only
        usingWeaponMods: [
          [
            { id: "item-id-8", name: "Item Name 8", shortName: "Item Shortname 8" },
          ],
        ], // Optional | Console-only
        wearing: [
          { id: "item-id-9", name: "Item Name 9", shortName: "Item Shortname 9" },
        ], // Optional | Console-only
        notWearing: [
          { id: "item-id-10", name: "Item Name 10", shortName: "Item Shortname 10" },
        ], // Optional | Console-only
        distance: 65, // Optional | Console-only
        minDurability: 40, // Optional | Console-only
        maxDurability: 85, // Optional | Console-only
        timeFromHour: 2, // Optional | Console-only
        timeUntilHour: 6, // Optional | Console-only
      },
      {
        id: "objective-id-6", // Required | UI (logic)
        description: "Objective Description 6.", // Required | UI
        type: "findQuestItem", // Optional | UI (logic); map view filtering recognizes: "mark" | "zone" | "extract" | "visit" | "findItem" | "findQuestItem" | "plantItem" | "plantQuestItem" | "shoot"
        maps: [{ id: "map-id-1", name: "Map Name 1" }], // Optional | UI (logic)
        item: { id: "item-id-11", name: "Item Name 11", shortName: "Item Shortname 11" }, // Optional | UI (logic)
        questItem: {
          id: "item-id-12",
          name: "Item Name 12",
          shortName: "Item Shortname 12",
        }, // Optional | UI (logic)
        markerItem: {
          id: "item-id-13",
          name: "Item Name 13",
          shortName: "Item Shortname 13",
        }, // Optional | UI (logic)
        containsAll: [
          { id: "item-id-14", name: "Item Name 14", shortName: "Item Shortname 14" },
          { id: "item-id-15", name: "Item Name 15", shortName: "Item Shortname 15" },
        ], // Optional | Console-only
      },
    ], // Required | UI (logic); at least one objective in additions
  },
}
```
