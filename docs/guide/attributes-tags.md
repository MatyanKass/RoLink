# Attributes and tags

> Setting, removing and searching attributes and CollectionService tags on each route.

## When to use

Data on an instance that scripts read (`GetAttribute`), or grouping instances for a system (`CollectionService`).

## Rules by route

| Route | Attributes | Tags |
|---|---|---|
| Mirror JSON | `attrs` is the **complete** set: a key you drop is removed | `tags` is the **complete** set |
| `build` | `attrs` sets | `tags` adds |
| `set` | `attrs` merges | `tags` adds, `untag` removes |
| Script files | Not representable, use `set` | Not representable, use `set` |

## Mirror

```json file=Workspace/Coin.Part.json
{"CFrame":{"p":[0,3,0]},"Size":[2,2,0.4],"attrs":{"Value":10,"Rarity":"Common"},"tags":["Pickup"]}
```

## Tools

```call
set {"path":"Workspace/Coin","attrs":{"Value":25,"Tint":{"Color3":"#FFD700"}},"tags":["Pickup"],"untag":["Old"]}
```

Removing an attribute through `set` needs `edits` and `removeFalseAttrs`. Every attribute set to `false` in that edit is removed:

```call
set {"edits":[{"path":"Workspace/Coin","attrs":{"Rarity":false},"removeFalseAttrs":true}]}
```

JSON `null` does not remove anything, because the value never reaches Studio.

## Types

Numbers, strings and booleans are plain. Other types are wrapped: `{"Color3":"#FF0000"}`, `{"Vector3":[1,2,3]}`. The full list is in [property-types](property-types.md).

## Finding

```call
find {"root":"game","tag":"Pickup"}

find {"attr":"Rarity","attrValue":"Common"}

get {"path":"Workspace/Coin"}
```

`get` returns `attrs` and `tags` with every property. `attrValue` compares numbers, strings and booleans only.

## From scripts

```lua
local CollectionService = game:GetService("CollectionService")

local function setup(coin)
	coin.Touched:Connect(function(hit)
		print(coin:GetAttribute("Value"))
	end)
end

for _, coin in CollectionService:GetTagged("Pickup") do
	setup(coin)
end
CollectionService:GetInstanceAddedSignal("Pickup"):Connect(setup)
```

## Gotchas

- When adding one tag through a file, keep the existing ones in the list.
- Attribute names: letters, numbers and underscores, up to 100 characters. A bad name goes to `warnings` or `_errors.log`.
- Instance references cannot be attributes.
- `tags` with no `untag` in `set` only adds.
- RoLink's own markers are listed in [plugin-internals](plugin-internals.md). Do not remove them while the feature that set them is in use.
