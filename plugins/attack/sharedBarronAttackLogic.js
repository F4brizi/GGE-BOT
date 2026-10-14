if (require("node:worker_threads").isMainThread)
    return module.exports = { hidden: true }

const pretty = require("pretty-time")

const { spendSkip, haveEnoughSkips } = require("../skips.js")
const { castles, ClientCommands, AreaType, KingdomID, movements, movementEvents, resources } = require("../../protocols")
const {
    waitToAttack,
    getAttackInfo,
    assignUnit,
    getAmountSoldiersFlank,
    getAmountSoldiersFront,
    getMaxUnitsInReinforcementWave,
    getTotalAmountToolsFlank } = require("./attack.js")
const { waitForCommanderAvailable, freeCommander, useCommander } = require("../commander")
const { sendXT, waitForResult, botConfig, playerInfo } = require("../../ggeBot.js")
const err = require("../../err.json")
const minTroopCount = 80
const troopBlackList = [277]

try {
    var { recruitTroops } = require("../../plugins-extra/externalEventHelper.js")
}
catch (e) {
    console.debug(e)
}

let greatEmpireTactics = null
try {
    greatEmpireTactics = require("./barron_tactics_compact.json")
} catch (e) {
    console.debug("Could not load barron_tactics_compact.json", e)
}

const BASIC_DUMMY_IDS = [601, 602, 603, 607, 608, 652, 746]

// Precomputed table of victory ranges [minV, maxV] per level for Great Empire (kingdomID = 0)
const levelVictoryRanges = {}
for (let v = 0; v <= 3000; v++) {
    const lvl = Math.floor(1.9 * Math.pow(v, 0.555)) + 1
    if (!levelVictoryRanges[lvl]) {
        levelVictoryRanges[lvl] = { minV: v, maxV: v }
    } else {
        levelVictoryRanges[lvl].maxV = v
    }
}

function resolveBarronTactic(areaInfo, kingdomID) {
    const victories = Number(areaInfo.extraData?.[1] || 0)
    const baseOffset = [1, 35, 20, 45][kingdomID] ?? 0
    const level = Math.floor(1.9 * Math.pow(victories, 0.555)) + baseOffset

    if (kingdomID !== KingdomID.greatEmpire || !greatEmpireTactics) {
        return { level, tactic: null, variantKey: String(level), subIdx: 1, victories }
    }

    const range = levelVictoryRanges[level]
    // The community/wiki presets count DOWN remaining victories to next level:
    // e.g. Level 7 has 3 victories (v=8, 9, 10).
    // v=8 -> 10 - 8 + 1 = 3 -> Variant 7.3 ("Level 7.3 Victory to Level 8")
    // v=9 -> 10 - 9 + 1 = 2 -> Variant 7.2 ("Level 7.2 Victory to Level 8")
    // v=10 -> 10 - 10 + 1 = 1 -> Variant 7.1 ("Level 7.1 Victory to Level 8")
    let subIdx = 1
    if (range) {
        subIdx = Math.max(1, range.maxV - victories + 1)
    }
    const variantKey = `${level}.${subIdx}`

    const tactic = greatEmpireTactics[variantKey] || greatEmpireTactics[String(level)] || null
    return { level, tactic, variantKey, subIdx, victories }
}

function getUnitMatcher(req) {
    if (!req) return null
    const name = (req.name || "").toLowerCase().trim().replace(/^[\+\*\s]+/, '')

    // 1. Dummy: explicitly marked as dummy, count == 1, or sacrificial units (martyr, sp, spear)
    // Any light melee or basic unit in dPool can function as dummy!
    if (req.role === "dummy" || req.count === 1 || ['sp', 'spear', 'spearmen', 'martyr'].includes(name)) {
        return null // Handled directly via dPool
    }

    // 2. Heavy Ranged: Hc, Vhc, Hcb, etc. (Tier 2/3 ranged, rangeAttack >= 85)
    if (['hc', 'hcb', 'vhc', 'vcb'].includes(name) || name.includes('hc')) {
        return (u) => Number(u.unitInfo.rangeAttack || 0) >= 85
    }
    // 3. Light / Basic Ranged: Cb, Crossbowmen, Bow, Bowman (Tier 1 ranged, rangeAttack < 85)
    if (['cb', 'crossbowmen', 'bow', 'bm'].includes(name) || name.includes('cb')) {
        return (u) => Number(u.unitInfo.rangeAttack || 0) < 85
    }
    // 4. Heavy Melee: Ths, Th, Vmm, Vm, Berserkers, Knights (Tier 2/3 melee, meleeAttack >= 100)
    if (['ths', 'th', 'vmm', 'vm', 'beserkers', 'knight', 'knights'].includes(name) || name.includes('ths') || name.includes('vmm')) {
        return (u) => Number(u.unitInfo.meleeAttack || 0) >= 100
    }
    // 5. Light / Basic Melee: Mm, Macemen, Sw, Sm, Sp (Tier 1 melee, meleeAttack < 100)
    // All light melee (Maceros, Espadachines, Piqueros) can fulfill this!
    if (['mm', 'macemen', 'sw', 'sm', 'sp', 'spear', 'spearmen'].includes(name) || name.includes('mm') || name.includes('sw')) {
        return (u) => Number(u.unitInfo.meleeAttack || 0) < 100
    }
    return null
}

function allocateUnitsToFlank(flankSlots, requirements, mPool, rPool, dPool, maxCapacity) {
    if (!flankSlots || flankSlots.length === 0) return 0
    let slotIdx = 0
    let totalAssigned = 0
    for (const req of (requirements || [])) {
        let needed = req.count || 0
        if (req.fill || needed <= 0) needed = Math.max(0, maxCapacity - totalAssigned)

        const rawName = (req.name || "").toLowerCase().trim().replace(/^[\+\*\s]+/, '')
        const isDummy = req.role === "dummy" || req.count === 1 || ['sp', 'spear', 'spearmen', 'martyr'].includes(rawName)

        let pool = mPool
        if (isDummy) {
            // Any light melee or cheap basic unit in dPool functions as dummy!
            pool = dPool.length > 0 ? dPool : (mPool.length > 0 ? mPool : rPool)
        } else if (req.role === "ranged") {
            pool = rPool.length > 0 ? rPool : mPool
        } else if (req.role === "melee") {
            pool = mPool.length > 0 ? mPool : rPool
        }

        const matcher = getUnitMatcher(req)

        while (needed > 0 && slotIdx < flankSlots.length) {
            const slot = flankSlots[slotIdx]
            if (slot[0] !== -1 && slot[1] > 0) {
                slotIdx++
                continue
            }

            // Priority 1: Match exact requested archetype (e.g. Hc vs Cb, Ths vs Mm)
            let unitIdx = -1
            if (matcher) {
                unitIdx = pool.findIndex(u => u.amount > 0 && matcher(u))
            }
            // Priority 2: Fallback to any available unit in pool
            if (unitIdx === -1) {
                unitIdx = pool.findIndex(u => u.amount > 0)
            }

            if (unitIdx === -1) {
                if (req.role !== "dummy") {
                    const fallback = (pool === mPool) ? rPool : mPool
                    const fbIdx = fallback.findIndex(u => u.amount > 0)
                    if (fbIdx !== -1) {
                        pool = fallback
                        continue
                    }
                }
                break
            }
            const unit = pool[unitIdx]
            const take = Math.min(unit.amount, needed)
            slot[0] = unit.unitInfo.wodID
            slot[1] = take
            unit.amount -= take
            needed -= take
            totalAssigned += take
            if (unit.amount <= 0) pool.splice(unitIdx, 1)
            slotIdx++
        }
    }
    return totalAssigned
}

function allocateToolsToFlank(flankSlots, requirements, wPool, sPool, gPool) {
    if (!flankSlots || flankSlots.length === 0) return 0
    let slotIdx = 0
    let totalAssigned = 0
    for (const req of (requirements || [])) {
        let needed = req.count || 0
        let pool = wPool
        if (req.type === "shield") pool = sPool
        else if (req.type === "gate") pool = gPool
        else pool = wPool

        while (needed > 0 && slotIdx < flankSlots.length) {
            const slot = flankSlots[slotIdx]
            if (slot[0] !== -1 && slot[1] > 0) {
                slotIdx++
                continue
            }
            const toolIdx = pool.findIndex(t => t.amount > 0)
            if (toolIdx === -1) break
            const tool = pool[toolIdx]
            const take = Math.min(tool.amount, needed)
            slot[0] = tool.unitInfo.wodID
            slot[1] = take
            tool.amount -= take
            needed -= take
            totalAssigned += take
            if (tool.amount <= 0) pool.splice(toolIdx, 1)
            slotIdx++
        }
    }
    return totalAssigned
}

async function barronHit(type, kingdomID, options, maxLevel) {
    const getLevel = victorys =>
        Math.floor(1.9 * Math.pow(victorys, .555)) + ([1, 35, 20, 45][kingdomID] ?? 0)

    const isGreatEmpire = kingdomID === KingdomID.greatEmpire
    const validBaseTypes = isGreatEmpire
        ? [AreaType.mainCastle, AreaType.outpost]
        : [AreaType.externalKingdom, AreaType.mainCastle]

    const myBases = castles.filter(e => e.kingdomID == kingdomID &&
        validBaseTypes.includes(e.areaInfo.type))

    if (myBases.length === 0) {
        const fallback = castles.find(e => e.kingdomID == kingdomID)
        if (fallback) myBases.push(fallback)
    }

    const areaMap = new Map()
    for (const base of myBases) {
        do {
            try {
                const resp = await ClientCommands.getAreaInfo(kingdomID,
                    base.areaInfo.x - 50, base.areaInfo.y - 50,
                    base.areaInfo.x + 50, base.areaInfo.y + 50)
                for (const ai of resp.areaInfo) {
                    if (ai.type == type) {
                        const key = `${ai.x}_${ai.y}`
                        if (!areaMap.has(key)) areaMap.set(key, ai)
                    }
                }
                break
            } catch (e) {
                console.warn(e)
                break
            }
        } while (true)
    }

    // Senior Dev Architecture: Voronoi Territorial Partitioning
    // Each robber baron belongs strictly to its closest base within a max farming radius (default: 28 tiles).
    const MAX_FARMING_RADIUS = 28
    const MAX_FARMING_RADIUS_SQ = MAX_FARMING_RADIUS * MAX_FARMING_RADIUS

    const baseSectors = new Map() // base.id -> Array of { areaInfo, distSq, dist }
    for (const base of myBases) {
        baseSectors.set(base.id, [])
    }

    for (const ai of areaMap.values()) {
        let closestBase = null
        let minD = Infinity
        for (const base of myBases) {
            const d = Math.pow(base.areaInfo.x - ai.x, 2) + Math.pow(base.areaInfo.y - ai.y, 2)
            if (d < minD) {
                minD = d
                closestBase = base
            }
        }

        if (closestBase && minD <= MAX_FARMING_RADIUS_SQ) {
            baseSectors.get(closestBase.id).push({
                areaInfo: ai,
                distSq: minD,
                dist: Math.sqrt(minD)
            })
        }
    }

    // Sort each sector's barons strictly by distance ascending (closest first)
    const allAssignedBarons = []
    for (const base of myBases) {
        const sector = baseSectors.get(base.id)
        sector.sort((a, b) => a.distSq - b.distSq)
        sector.forEach(item => allAssignedBarons.push(item.areaInfo))
    }

    // Fallback if no barons within radius (e.g. edge of map or isolated base)
    var areas = allAssignedBarons.length > 0 ? allAssignedBarons : Array.from(areaMap.values())

    function inspectBaseTroops(baseCastle) {
        const dummyTroops = []
        const attackerMeleeTroops = []
        const attackerRangeTroops = []
        const attackerShieldTools = []
        const attackerWallTools = []
        const attackerGateTools = []

        for (let i = 0; i < baseCastle.unitInventory.length; i++) {
            const unit = baseCastle.unitInventory[i]
            if (unit.amount <= 0)
                continue

            if (unit.unitInfo.toolCategory &&
                unit.unitInfo.usageEventID == undefined &&
                unit.unitInfo.allowedToAttack == undefined &&
                unit.unitInfo.typ == 'Attack' &&
                unit.unitInfo.amountPerWave == undefined) {
                if (unit.unitInfo.wallBonus)
                    attackerWallTools.push(unit)
                else if (unit.unitInfo.defRangeBonus)
                    attackerShieldTools.push(unit)
                else if (unit.unitInfo.gateBonus)
                    attackerGateTools.push(unit)
            }
            else if (unit.unitInfo.fightType == 0 &&
                unit.unitInfo.beefSupply == undefined) {
                if (options.foodTroopsOnly && unit.unitInfo.meadSupply)
                    continue
                if (!options.useDogs && unit.unitInfo.wodID == 277)
                    continue
                if (options.useDogs && unit.unitInfo.wodID != 277)
                    continue

                const isBarracksUnit = unit.unitInfo.name === "Barracks" || unit.unitInfo.group === "Barracks"
                const isDummyCandidate = BASIC_DUMMY_IDS.includes(unit.unitInfo.wodID) ||
                    unit.unitInfo.name === "Keep" ||
                    unit.unitInfo.group === "Keep" ||
                    (isBarracksUnit && !unit.unitInfo.costC2 && (
                        Number(unit.unitInfo.costC1 || 0) <= 85 ||
                        (unit.unitInfo.role === "melee" && Number(unit.unitInfo.meleeAttack || 0) < 100)
                    ))

                const clonedUnit = { unitInfo: unit.unitInfo, amount: unit.amount }

                if (isDummyCandidate) {
                    dummyTroops.push(clonedUnit)
                }

                if (unit.unitInfo.role == "melee")
                    attackerMeleeTroops.push(clonedUnit)
                else if (unit.unitInfo.role == "ranged")
                    attackerRangeTroops.push(clonedUnit)
            }
        }

        let totalAttackTroops = 0
        let heavyRanged = 0
        let lightRanged = 0
        let heavyMelee = 0
        let lightMelee = 0

        for (const e of attackerRangeTroops) {
            totalAttackTroops += e.amount
            if (Number(e.unitInfo.rangeAttack || 0) >= 85) heavyRanged += e.amount
            else lightRanged += e.amount
        }
        for (const e of attackerMeleeTroops) {
            totalAttackTroops += e.amount
            if (Number(e.unitInfo.meleeAttack || 0) >= 100) heavyMelee += e.amount
            else lightMelee += e.amount
        }

        return {
            dummyTroops,
            attackerMeleeTroops,
            attackerRangeTroops,
            attackerShieldTools,
            attackerWallTools,
            attackerGateTools,
            totalAttackTroops,
            heavyRanged,
            lightRanged,
            heavyMelee,
            lightMelee
        }
    }

    async function skipTarget(areaInfo) {
        while (areaInfo.extraData[2] > 0) {
            let skip = spendSkip(areaInfo.extraData[2])

            if (skip == undefined)
                throw new Error("couldntFindSkip")

            const { result } = await ClientCommands.skipTarget(type, areaInfo.x, areaInfo.y, kingdomID, skip)

            if (result != 0)
                break
        }
    }
    
    movementEvents.on("returning", (/** @type {import("../../protocols.js").ClassTypes.Movement} */ movement) => {
        if (movement.targetOwner.ownerID != playerInfo.playerID)
            return

        if(movement.kingdomID != kingdomID)
            return

        if (movement.sourceAttack.type != type)
            return

        const shouldUpgradeTower = options.upgradeTowers && getLevel(movement.sourceAttack.extraData[1], kingdomID) != maxLevel
        
        if ((options.useTimeSkips || shouldUpgradeTower) && 
            movements.find(movement2 => 
                movement2.kingdomID           == kingdomID               &&
                movement2.sourceAttack.type   == type                    && 
                movement2.sourceAttack.x      == movement.sourceAttack.x && 
                movement2.sourceAttack.y      == movement.sourceAttack.y))
                skipTarget(movement.sourceAttack)
    })

    const sendHit = async () => {
        const commander = await waitForCommanderAvailable(options.commanderWhiteList)
        const hasShieldMadiens = commander.getEffects(type).AttackSupportUnits
        try {
            const attackInfo = await waitToAttack(async () => {
                const timeSinceEpoch = Date.now()
                let bestCandidate = null
                let anyBaseHasTroops = false

                // Evaluate each base strictly on its own exclusive sector
                for (const base of myBases) {
                    const sector = baseSectors.get(base.id)
                    if (!sector || sector.length === 0)
                        continue

                    const troopData = inspectBaseTroops(base)
                    if (troopData.totalAttackTroops >= 5) {
                        anyBaseHasTroops = true
                    } else {
                        // Base has no troops right now: strictly wait for its troops, never steal another base's targets!
                        continue
                    }

                    // Find closest ready baron in this base's sector
                    for (const item of sector) {
                        const areaInfo = item.areaInfo
                        const shouldUpgradeTower = options.upgradeTowers && getLevel(areaInfo.extraData[1], kingdomID) != maxLevel
                        const skipsPerTower = 7200

                        const coinSkips = recruitTroops ? Math.floor(resources.coins / (1000 / (20 * 5))) : 0
                        const enoughSkips = haveEnoughSkips(skipsPerTower * movements.reduce((count, movement) =>
                            (movement.targetAttack.type == type ? count++ : count, count), 0) - coinSkips) || (recruitTroops && resources.coins > 25000)

                        if (enoughSkips && (options.useTimeSkips || shouldUpgradeTower)) {
                            try {
                                await skipTarget(areaInfo)
                            }
                            catch (e) {
                                console.warn(e)
                                continue
                            }
                        }
                        else if (((areaInfo.timeSinceRequest + areaInfo.extraData[2] * 1000) - timeSinceEpoch) > 0)
                            continue
                        else if (movements.find(movement =>
                            movement.kingdomID == kingdomID &&
                            movement.targetAttack.x == areaInfo.x && movement.targetAttack.y == areaInfo.y))
                            continue

                        const { level, tactic, variantKey } = resolveBarronTactic(areaInfo, kingdomID)
                        let requiredTroops = 10
                        let reqHeavyRanged = 0
                        let reqLightRanged = 0
                        let reqHeavyMelee = 0
                        let reqLightMelee = 0

                        if (tactic && tactic.waves && tactic.waves.length > 0) {
                            let totalReq = 0
                            tactic.waves.forEach(w => {
                                const allFlanks = [w.left_troops || [], w.front_troops || [], w.right_troops || []]
                                allFlanks.forEach(flank => {
                                    flank.forEach(req => {
                                        const count = req.count || 0
                                        totalReq += count
                                        const name = (req.name || "").toLowerCase().trim().replace(/^[\+\*\s]+/, '')
                                        const isDummyReq = req.role === "dummy" || req.count === 1 || ['sp', 'spear', 'spearmen', 'martyr'].includes(name)
                                        if (isDummyReq) {
                                            // Sacrificial dummies: fulfilled by any light melee or basic dummy troop
                                        } else if (['hc', 'hcb', 'vhc', 'vcb'].includes(name) || name.includes('hc')) {
                                            reqHeavyRanged += count
                                        } else if (['cb', 'crossbowmen', 'bow', 'bm'].includes(name) || name.includes('cb')) {
                                            reqLightRanged += count
                                        } else if (['ths', 'th', 'vmm', 'vm', 'beserkers', 'knight', 'knights'].includes(name) || name.includes('ths') || name.includes('vmm')) {
                                            reqHeavyMelee += count
                                        } else if (['mm', 'macemen', 'sw', 'sm'].includes(name) || name.includes('mm')) {
                                            reqLightMelee += count
                                        }
                                    })
                                })
                            })
                            if (totalReq > 0) requiredTroops = totalReq
                        }

                        // Check total troops and specific archetype availability so we never send weak light troops to high targets
                        const hasEnoughTroops = troopData.totalAttackTroops >= requiredTroops &&
                            (reqHeavyRanged === 0 || troopData.heavyRanged >= reqHeavyRanged) &&
                            (reqHeavyMelee === 0 || troopData.heavyMelee >= reqHeavyMelee)

                        if (hasEnoughTroops) {
                            // Valid candidate for this base!
                            if (!bestCandidate || item.distSq < bestCandidate.distSq) {
                                bestCandidate = {
                                    base,
                                    areaInfo,
                                    level,
                                    variantKey,
                                    tactic,
                                    troopData,
                                    distSq: item.distSq,
                                    dist: item.dist
                                }
                            }
                            // Sector is sorted closest-first, so this is the closest ready target for this base
                            break
                        }
                    }
                }

                if (!bestCandidate) {
                    if (!anyBaseHasTroops)
                        throw "NO_MORE_TROOPS"
                    return // All sector targets are on cooldown or currently have active movements
                }

                const castle = bestCandidate.base
                const areaInfo = bestCandidate.areaInfo
                const level = bestCandidate.level
                const variantKey = bestCandidate.variantKey
                const tactic = bestCandidate.tactic
                const { dummyTroops, attackerMeleeTroops, attackerRangeTroops, attackerShieldTools, attackerWallTools, attackerGateTools } = bestCandidate.troopData

                // Economic sorting: cheapest/weakest units first to protect elite event troops
                const isBarracks = (unit) => {
                    const info = unit.unitInfo || {}
                    const isRuby = info.costC2 && Number(info.costC2) > 0
                    if (isRuby) return false
                    return info.name === "Barracks" || info.group === "Barracks" || (Number(info.costC1 || 0) > 0 && info.name !== "Eventunit")
                }

                const sortEconomic = (a, b) => {
                    const aIsElite = isBarracks(a) ? 0 : 1
                    const bIsElite = isBarracks(b) ? 0 : 1
                    if (aIsElite !== bIsElite) return aIsElite - bIsElite

                    if (aIsElite === 0) {
                        // Barracks recruit-able: cheapest / lowest coin cost first
                        const aCost = Number(a.unitInfo.costC1 || 0)
                        const bCost = Number(b.unitInfo.costC1 || 0)
                        if (aCost !== bCost) return aCost - bCost
                        const aPower = Number(a.unitInfo.meleeAttack || a.unitInfo.rangeAttack || 0)
                        const bPower = Number(b.unitInfo.meleeAttack || b.unitInfo.rangeAttack || 0)
                        return aPower - bPower
                    } else {
                        // Event / Elite troops: sort strongest first to win cleanly when used
                        const aPower = Number(a.unitInfo.meleeAttack || a.unitInfo.rangeAttack || 0)
                        const bPower = Number(b.unitInfo.meleeAttack || b.unitInfo.rangeAttack || 0)
                        return bPower - aPower
                    }
                }

                // Dummy units: strictly cheapest basic units first
                dummyTroops.sort((a, b) => {
                    const aCost = Number(a.unitInfo.costC1 || 0)
                    const bCost = Number(b.unitInfo.costC1 || 0)
                    if (aCost !== bCost) return aCost - bCost
                    const aPower = Number(a.unitInfo.meleeAttack || a.unitInfo.rangeAttack || 0)
                    const bPower = Number(b.unitInfo.meleeAttack || b.unitInfo.rangeAttack || 0)
                    return aPower - bPower
                })

                // Tools: non-ruby (wooden / stone / workshop) tools first
                const sortTools = (a, b) => {
                    const aIsRuby = (a.unitInfo.costC2 && Number(a.unitInfo.costC2) > 0) ? 1 : 0
                    const bIsRuby = (b.unitInfo.costC2 && Number(b.unitInfo.costC2) > 0) ? 1 : 0
                    if (aIsRuby !== bIsRuby) return aIsRuby - bIsRuby
                    const aBonus = Number(a.unitInfo.wallBonus || a.unitInfo.defRangeBonus || a.unitInfo.gateBonus || 0)
                    const bBonus = Number(b.unitInfo.wallBonus || b.unitInfo.defRangeBonus || b.unitInfo.gateBonus || 0)
                    return aBonus - bBonus
                }

                attackerWallTools.sort(sortTools)
                attackerShieldTools.sort(sortTools)
                attackerGateTools.sort(sortTools)

                attackerMeleeTroops.sort(sortEconomic)
                attackerRangeTroops.sort(sortEconomic)

                const autoConfigure = !(options.attackLeft || options.attackRight || options.attackMiddle)
                const commanderStats = commander.getEffects()
                const waveCount = (tactic && tactic.waves && tactic.waves.length > 0)
                    ? Math.max(tactic.waves.length, parseInt(options.attackWaves || 2))
                    : parseInt(options.attackWaves || 2)
                const attackInfo = getAttackInfo(kingdomID, castle, areaInfo, commander, level, waveCount, options, commanderStats.additionalWaves)

                const maxTroopFront = getAmountSoldiersFront(level, commanderStats.attackUnitAmountFront)
                const maxTroopFlank = getAmountSoldiersFlank(level, commanderStats.attackUnitAmountFlank)

                if (tactic && tactic.waves && tactic.waves.length > 0) {
                    // TÁCTICA QUIRÚRGICA: Wiki Presets
                    tactic.waves.forEach((tWave, wIdx) => {
                        const wave = attackInfo.A[wIdx]
                        if (!wave) return

                        allocateUnitsToFlank(wave.L.U, tWave.left_troops, attackerMeleeTroops, attackerRangeTroops, dummyTroops, maxTroopFlank)
                        allocateToolsToFlank(wave.L.T, tWave.left_tools, attackerWallTools, attackerShieldTools, attackerGateTools)

                        allocateUnitsToFlank(wave.M.U, tWave.front_troops, attackerMeleeTroops, attackerRangeTroops, dummyTroops, maxTroopFront)
                        allocateToolsToFlank(wave.M.T, tWave.front_tools, attackerWallTools, attackerShieldTools, attackerGateTools)

                        allocateUnitsToFlank(wave.R.U, tWave.right_troops, attackerMeleeTroops, attackerRangeTroops, dummyTroops, maxTroopFlank)
                        allocateToolsToFlank(wave.R.T, tWave.right_tools, attackerWallTools, attackerShieldTools, attackerGateTools)
                    })
                } else {
                    const maxTroopFront = getAmountSoldiersFront(level, commanderStats.attackUnitAmountFront)
                    const maxTroopFlank = getAmountSoldiersFlank(level, commanderStats.attackUnitAmountFlank)
                    const maxToolsFlank = options.useShields ? getTotalAmountToolsFlank(level, 0) : 10

                    attackInfo.A.forEach((wave, index) => {
                        let maxTroops = maxTroopFlank

                        if (index == 0 && options.useWallTools) {
                            const desiredToolCount = 10
                            let maxTools = maxToolsFlank
                            if (autoConfigure ? true : options.attackLeft) {
                                wave.L.T.forEach((unitSlot, i) =>
                                    maxTools -= assignUnit(unitSlot, i == 0 ?
                                        attackerWallTools : attackerShieldTools, Math.min(maxTools, desiredToolCount)))

                                wave.L.U.forEach(unitSlot =>
                                    maxTroops -= assignUnit(unitSlot, attackerRangeTroops.length <= 0 ?
                                        attackerMeleeTroops : attackerRangeTroops, maxTroops))
                            }
                            maxTools = maxToolsFlank
                            if (options.attackRight) {
                                wave.R.T.forEach((unitSlot, i) =>
                                    maxTools -= assignUnit(unitSlot, i == 0 ?
                                        attackerWallTools : attackerShieldTools, Math.min(maxTools, desiredToolCount)))

                                maxTroops = maxTroopFlank
                                wave.R.U.forEach(unitSlot =>
                                    maxTroops -= assignUnit(unitSlot, attackerRangeTroops.length <= 0 ?
                                        attackerMeleeTroops : attackerRangeTroops, maxTroops))
                            }
                            maxTools = maxToolsFlank
                            if (options.attackMiddle) {
                                wave.M.T.forEach((unitSlot, i) =>
                                    maxTools -= assignUnit(unitSlot, i == 0 ?
                                        attackerWallTools : attackerShieldTools, Math.min(maxTools, desiredToolCount)))

                                maxTroops = maxTroopFront
                                wave.M.U.forEach(unitSlot =>
                                    maxTroops -= assignUnit(unitSlot, attackerRangeTroops.length <= 0 ?
                                        attackerMeleeTroops : attackerRangeTroops, maxTroops))
                            }
                            return
                        }

                        if (autoConfigure ? true : options.attackLeft) {
                            wave.L.U.forEach(unitSlot =>
                                maxTroops -= assignUnit(unitSlot, attackerMeleeTroops.length <= 0 ?
                                    attackerRangeTroops : attackerMeleeTroops, maxTroops))
                        }
                        if (options.attackRight) {
                            maxTroops = maxTroopFlank
                            wave.R.U.forEach(unitSlot =>
                                maxTroops -= assignUnit(unitSlot, attackerMeleeTroops.length <= 0 ?
                                    attackerRangeTroops : attackerMeleeTroops, maxTroops))
                        }
                        if (options.attackMiddle) {
                            maxTroops = maxTroopFront
                            wave.M.U.forEach(unitSlot =>
                                maxTroops -= assignUnit(unitSlot, attackerMeleeTroops.length <= 0 ?
                                    attackerRangeTroops : attackerMeleeTroops, maxTroops))
                        }
                    })
                }

                const shouldAttackCourtyard = Boolean(options.attackCourtyard)
                if (shouldAttackCourtyard && (!hasShieldMadiens)) {
                    let maxTroops = getMaxUnitsInReinforcementWave(playerInfo.level, level) + Number(0 | commanderStats.attackUnitAmountReinforcementBonus)
                    attackInfo.RW.forEach((unitSlot, i) => {
                        let attacker = i & 1 ?
                            (attackerRangeTroops.length > 0 ? attackerRangeTroops : attackerMeleeTroops) :
                            (attackerMeleeTroops.length > 0 ? attackerMeleeTroops : attackerRangeTroops)

                        maxTroops -= assignUnit(unitSlot, attacker,
                            Math.floor(maxTroops / 2) - 1)
                    })
                }

                await sendXT("cra", JSON.stringify(attackInfo))

                let [obj, result] = await waitForResult("cra", 1000 * 10, (obj, result) => {
                    if (result != 0)
                        return true

                    if (obj.AAM.M.KID != kingdomID || obj.AAM.M.TA[1] != areaInfo.x || obj.AAM.M.TA[2] != areaInfo.y)
                        return false
                    return true
                })

                if (result != 0)
                    throw err[result]

                const baseName = castle.areaInfo.name ? `${castle.areaInfo.name} (${castle.areaInfo.x}:${castle.areaInfo.y})` : `Base (${castle.areaInfo.x}:${castle.areaInfo.y})`
                const targetDistance = Math.round(Math.sqrt(Math.pow(castle.areaInfo.x - areaInfo.x, 2) + Math.pow(castle.areaInfo.y - areaInfo.y, 2)))

                return { obj, baseName, targetDistance, level, variantKey }
            })

            if (!attackInfo) {
                freeCommander(commander.lordID)
                return false
            }
            
            const { obj, baseName, targetDistance, level, variantKey } = attackInfo
            const variantLabel = (isGreatEmpire && variantKey) ? `Lvl ${level} (${variantKey})` : `Lvl ${level}`
            console.info("hittingTargetAttack", KingdomID[kingdomID], variantLabel, 'C' + (obj.AAM.UM.L.VIS + 1), obj.AAM.M.TA[1] + ':' + obj.AAM.M.TA[2], "from", baseName, `[${targetDistance} tiles]`, pretty(Math.round(1000000000 * Math.abs(Math.max(0, obj.AAM.M.TT - obj.AAM.M.PT))), 's'), "tillImpactAttack")
            return true
        } catch (e) {
            freeCommander(commander.lordID)
            switch (e) {
                case "NO_MORE_TROOPS":
                    try {
                        if (botConfig.externalEvent && kingdomID == KingdomID.greatEmpire && recruitTroops) {
                            const recruitBase = myBases.find(b => b.areaInfo.type == AreaType.mainCastle) || myBases[0]
                            await recruitTroops(recruitBase)
                            return true
                        }
                    }
                    catch (e) {
                        console.debug(e)
                    }
                    console.log(`[${KingdomID[kingdomID]}] Waiting for more troops in any base`)
                    const baseIds = myBases.map(b => b.id)
                    await new Promise(resolve => {
                        const timeout = setTimeout(() => {
                            movementEvents.off("return", onReturn)
                            resolve()
                        }, 60000).unref()

                        function onReturn(/** @type {import("../../protocols.js").ClassTypes.Movement} */ movement) {
                            if (movement.kingdomID != kingdomID || !baseIds.includes(movement.targetAttack.extraData[0]))
                                return

                            clearTimeout(timeout)
                            movementEvents.off("return", onReturn)
                            resolve()
                        }
                        movementEvents.on("return", onReturn)
                    })
                    return true
                case "LORD_IS_USED":
                    useCommander(commander.lordID)
                case "COOLING_DOWN":
                case "TIMED_OUT":
                case "MISSING_UNITS":
                case "ATTACK_TOO_MANY_UNITS":
                    return true
                case "CANT_START_NEW_ARMIES":
                default:
                    throw e
            }
        }
    }

    while (true) {
        if (!options.useTimeSkips && !options.upgradeTowers) {
            let minimumTimeTillHit = 5 * 1000 + Date.now()

            areas.forEach(areaInfo => {
                if (movements.find(movement =>
                    movement.kingdomID == kingdomID &&
                    movement.targetAttack.x == areaInfo.x && movement.targetAttack.y == areaInfo.y))
                    return

                minimumTimeTillHit = Math.min(minimumTimeTillHit, (areaInfo.timeSinceRequest + areaInfo.extraData[2] * 1000))
            })

            const time = (Math.max(0, minimumTimeTillHit - Date.now()))
            if (time > 0)
                console.info("waitingForNextPossibleHit", Math.round(time / 1000), "waitingForNextPossibleHit2")
            await new Promise(r => setTimeout(r, time).unref())
        }

        while (await sendHit());
    }
}

module.exports = barronHit