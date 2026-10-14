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
            }
            else if (unit.unitInfo.fightType == 0 &&
                unit.unitInfo.beefSupply == undefined) {
                if (options.foodTroopsOnly && unit.unitInfo.meadSupply)
                    continue
                if (!options.useDogs && unit.unitInfo.wodID == 277)
                    continue
                if (options.useDogs && unit.unitInfo.wodID != 277)
                    continue

                if (BASIC_DUMMY_IDS.includes(unit.unitInfo.wodID) || unit.unitInfo.group === "Keep") {
                    dummyTroops.push(unit)
                }

                if (unit.unitInfo.role == "melee")
                    attackerMeleeTroops.push(unit)
                else if (unit.unitInfo.role == "ranged")
                    attackerRangeTroops.push(unit)
            }
        }

        let totalAttackTroops = 0
        attackerRangeTroops.forEach(e => totalAttackTroops += e.amount)
        attackerMeleeTroops.forEach(e => totalAttackTroops += e.amount)

        return {
            dummyTroops,
            attackerMeleeTroops,
            attackerRangeTroops,
            attackerShieldTools,
            attackerWallTools,
            totalAttackTroops
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

                        const level = getLevel(areaInfo.extraData[1], kingdomID)
                        const tactic = (isGreatEmpire && greatEmpireTactics) ? greatEmpireTactics[level] : null
                        let requiredTroops = 10
                        if (tactic && tactic.waves && tactic.waves[0]) {
                            const w0 = tactic.waves[0]
                            const req = (w0.left_troops.reduce((s, x) => s + x.count, 0) +
                                         w0.front_troops.reduce((s, x) => s + x.count, 0) +
                                         w0.right_troops.reduce((s, x) => s + x.count, 0))
                            if (req > 0) requiredTroops = req
                        }

                        if (troopData.totalAttackTroops >= requiredTroops) {
                            // Valid candidate for this base!
                            if (!bestCandidate || item.distSq < bestCandidate.distSq) {
                                bestCandidate = {
                                    base,
                                    areaInfo,
                                    level,
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
                const tactic = bestCandidate.tactic
                const { dummyTroops, attackerMeleeTroops, attackerRangeTroops, attackerShieldTools, attackerWallTools } = bestCandidate.troopData

                // Economic sorting: cheapest/weakest units first to protect elite event troops
                const sortEconomic = (a, b) => {
                    const aIsElite = (a.unitInfo.group !== "Barracks" || (a.unitInfo.costC2 && a.unitInfo.costC2 > 0)) ? 1 : 0
                    const bIsElite = (b.unitInfo.group !== "Barracks" || (b.unitInfo.costC2 && b.unitInfo.costC2 > 0)) ? 1 : 0
                    if (aIsElite !== bIsElite) return aIsElite - bIsElite

                    const aPower = Number(a.unitInfo.meleeAttack || a.unitInfo.rangeAttack || 0)
                    const bPower = Number(b.unitInfo.meleeAttack || b.unitInfo.rangeAttack || 0)
                    return aPower - bPower
                }

                attackerWallTools.sort((a, b) =>
                    Number(a.unitInfo.wallBonus) - Number(b.unitInfo.wallBonus))

                attackerShieldTools.sort((a, b) =>
                    Number(a.unitInfo.defRangeBonus) - Number(b.unitInfo.defRangeBonus))

                attackerMeleeTroops.sort(sortEconomic)
                attackerRangeTroops.sort(sortEconomic)
                dummyTroops.sort(sortEconomic)

                const autoConfigure = !(options.attackLeft || options.attackRight || options.attackMiddle)
                const commanderStats = commander.getEffects()
                const waveCount = (tactic && tactic.waves && tactic.waves.length > 0)
                    ? Math.max(tactic.waves.length, parseInt(options.attackWaves || 2))
                    : parseInt(options.attackWaves || 2)
                const attackInfo = getAttackInfo(kingdomID, castle, areaInfo, commander, level, waveCount, options, commanderStats.additionalWaves)

                if (tactic && tactic.waves && tactic.waves.length > 0) {
                    // TÁCTICA QUIRÚRGICA: Wiki Presets
                    tactic.waves.forEach((tWave, wIdx) => {
                        const wave = attackInfo.A[wIdx]
                        if (!wave) return

                        const flanks = [
                            { flank: wave.L, troops: tWave.left_troops, tools: tWave.left_tools },
                            { flank: wave.M, troops: tWave.front_troops, tools: tWave.front_tools },
                            { flank: wave.R, troops: tWave.right_troops, tools: tWave.right_tools }
                        ]

                        flanks.forEach(({ flank, troops, tools }) => {
                            if (tools && tools.length > 0 && flank.T) {
                                tools.forEach((tReq, slotIdx) => {
                                    const toolPool = (tReq.type === "shield") ? attackerShieldTools : attackerWallTools
                                    if (flank.T[slotIdx]) {
                                        assignUnit(flank.T[slotIdx], toolPool, tReq.count)
                                    }
                                })
                            }

                            if (troops && troops.length > 0 && flank.U) {
                                troops.forEach((uReq, slotIdx) => {
                                    let pool = attackerMeleeTroops
                                    if (uReq.role === "dummy") {
                                        pool = dummyTroops.length > 0 ? dummyTroops : attackerMeleeTroops
                                    } else if (uReq.role === "ranged") {
                                        pool = attackerRangeTroops.length > 0 ? attackerRangeTroops : attackerMeleeTroops
                                    } else if (uReq.role === "melee") {
                                        pool = attackerMeleeTroops.length > 0 ? attackerMeleeTroops : attackerRangeTroops
                                    }

                                    if (flank.U[slotIdx]) {
                                        assignUnit(flank.U[slotIdx], pool, uReq.count)
                                    }
                                })
                            }
                        })
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

                if (autoConfigure ? (hasShieldMadiens ? false : true) : options.attackCourtyard) {
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

                return { obj, baseName, targetDistance }
            })

            if (!attackInfo) {
                freeCommander(commander.lordID)
                return false
            }
            
            const { obj, baseName, targetDistance } = attackInfo
            console.info("hittingTargetAttack", KingdomID[kingdomID], ' ', 'C', obj.AAM.UM.L.VIS + 1, ' ', obj.AAM.M.TA[1], ':', obj.AAM.M.TA[2], "from", baseName, `[${targetDistance} tiles]`, pretty(Math.round(1000000000 * Math.abs(Math.max(0, obj.AAM.M.TT - obj.AAM.M.PT))), 's'), "tillImpactAttack")
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