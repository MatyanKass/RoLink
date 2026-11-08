# Welds and constraints

> Joining parts: weld_model, WeldConstraint, Weld, Motor6D, physics constraints, collision groups.

## When to use

Parts must move together, or move relative to each other under physics.

Everything starts Anchored on RoLink's routes. An anchored part ignores physics, so a mechanism needs the moving parts unanchored.

## Quickest: weld a whole model

```call
weld_model {"path":"Workspace/Cart","unanchor":true}
```

Welds every part to one root part with WeldConstraints named `RoLinkWeld`, skipping pairs already welded. Root: the `root` argument (a path relative to `path`), else `PrimaryPart`, else the largest part. Result: `{root, created, skipped, parts}`. Works on a Model or Folder, with at least two parts.

In a build node, `"weld":true` on a Model does the same at creation, though without duplicate checks.

## WeldConstraint by hand

Keeps two parts at their current relative position.

```json file=Workspace/Cart.model/model.json
{"children":[
  {"name":"Base","class":"Part","CFrame":{"p":[0,1,0]},"Size":[6,1,4],"Anchored":false},
  {"name":"Top","class":"Part","CFrame":{"p":[0,2,0]},"Size":[4,1,3],"Anchored":false},
  {"name":"Join","class":"WeldConstraint","Part0":{"ref":"./Base"},"Part1":{"ref":"./Top"}}
]}
```

```json
{"class":"WeldConstraint","Part0":{"ref":"./Base"},"Part1":{"ref":"./Arm"}}
```

The second block is the same thing as a build node.

## Weld and Motor6D

`Weld` holds an offset: `Part0`, `Part1`, `C0`, `C1`, `Enabled`. `Motor6D` adds animation through `Transform`, and is how character joints work. See [tween-animation-import](tween-animation-import.md).

## Physics constraints

Almost all constraints join two Attachments. Common properties: `Attachment0`, `Attachment1`, `Enabled`, `Visible`, `Color`.

| Class | Use | Key properties |
|---|---|---|
| `HingeConstraint` | Door, wheel | `ActuatorType` (None, Motor, Servo), `AngularVelocity`, `MotorMaxTorque`, `TargetAngle`, `ServoMaxTorque`, `AngularSpeed`, `LimitsEnabled`, `LowerAngle`, `UpperAngle` |
| `BallSocketConstraint` | Free joint | `LimitsEnabled`, `UpperAngle`, `TwistLimitsEnabled` |
| `RopeConstraint` | Rope | `Length`, `Thickness`, `WinchEnabled` |
| `RodConstraint` | Fixed distance | `Length`, `Thickness` |
| `SpringConstraint` | Suspension | `FreeLength`, `Stiffness`, `Damping` |
| `PrismaticConstraint` | Slider | `ActuatorType`, `LimitsEnabled` |
| `CylindricalConstraint` | Slide and rotate | `AngularActuatorType` |
| `UniversalConstraint` | Two-axis joint | `MaxAngle` |
| `AlignPosition` | Pull to a point | `Mode`, `Position`, `MaxForce`, `Responsiveness`, `RigidityEnabled` |
| `AlignOrientation` | Turn to an orientation | `Mode`, `CFrame`, `MaxTorque`, `Responsiveness` |
| `LinearVelocity` | Constant velocity | `VectorVelocity`, `MaxForce`, `RelativeTo` |
| `AngularVelocity` | Constant spin | `AngularVelocity`, `MaxTorque` |
| `VectorForce` | Constant force | `Force`, `RelativeTo` |
| `Torque` | Constant torque | `Torque`, `RelativeTo` |
| `NoCollisionConstraint` | Disable collision between two parts | `Part0`, `Part1` |

## A hinged door

Attachments' `CFrame` is relative to their part. A hinge rotates about the attachment's X axis, so rotate the attachments to make that axis vertical.

```json file=Workspace/Gate.model/model.json
{"children":[
  {"name":"Post","class":"Part","CFrame":{"p":[0,4,0]},"Size":[1,8,1],"children":[
    {"name":"Hinge","class":"Attachment","CFrame":{"p":[0.5,0,0],"r":[0,0,90]}}
  ]},
  {"name":"Leaf","class":"Part","CFrame":{"p":[3,4,0]},"Size":[5,7,0.4],"Anchored":false,"children":[
    {"name":"Hinge","class":"Attachment","CFrame":{"p":[-2.5,0,0],"r":[0,0,90]}}
  ]},
  {"name":"Joint","class":"HingeConstraint","Attachment0":{"ref":"./Post/Hinge"},"Attachment1":{"ref":"./Leaf/Hinge"},
   "LimitsEnabled":true,"LowerAngle":-90,"UpperAngle":90}
]}
```

Physics does not run in edit mode. Test with a play-test.

## Reading joints

`_info.joints` in `model.json` lists each joint with its class, name and targets.

## Collision groups

```call
set_collision_groups {"register":["Ghosts"],"rules":[{"a":"Ghosts","b":"Default","collide":false}],"assign":[{"paths":"Workspace/Spirit","group":"Ghosts"}]}
```

A Model or Folder in `assign` includes all its parts unless `descendants` is false. A group not registered is refused before anything changes. Registering and rules may not be undoable, and the result says so. Result: `{assigned, warnings, groups, note}`.

## Gotchas

- `AlignPosition.Position` is not shown in mirror files. Use `get` to read it.
- If a welded assembly falls apart or does not move, check `Anchored` on all parts.
- One anchored part anchors its whole welded assembly.
- Welds made before a part moves keep the relative offset from when the weld became active.
