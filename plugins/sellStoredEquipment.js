if (require('node:worker_threads').isMainThread)
    return module.exports = {}

const { events, xtHandler, sendXT } = require('../ggeBot')
const gems = require("../items/gems.json")
const sellGems = e => {
    let gemsSold = 0
    Array.from(e.GEM).forEach(([id, amount]) => {
        const gem = gems.find(e => e.gemID == id)
        if(gem.setID != undefined)
            return

        for (let i = 0; i < amount; i++) {
            sendXT("sge", JSON.stringify({GID:gem.gemID,RGEM:0,LFID:-1}))
            gemsSold++
        }
    })

    console.log(gemsSold, 'gemsSold')
}
const equipmentType = {
    unique : 0,
    common : 1,
    rare : 2,
    epic : 3,
    legendary : 4,
    relic : 5,
    heroUnique : 10, 
    heroCommon : 11,
    heroRare : 12,
    heroEpic : 13,
    heroLegendary : 14,
    heroRelic : 15
}
class Equipment {
    constructor(e) {
        this.id = e[0]
        this.slotType = e[1]
        this.lordType = e[2]
        this.rarity = e[3]
        this.name = e[4]
        this.objectID = e[6]
        this.setID = e[7]
        this.enchantmentLevel = e[8]
        this.timeLeft = e[9] + Date.now() //TODO Verify
        this.temporary = e[9] > 0
        this.gemID = e[10]
    }
}

const sellEquipment = e => {
    let equipmentSold = 0
    const sellableRarities = [
        equipmentType.common,
        equipmentType.heroCommon,
        equipmentType.rare,
        equipmentType.heroRare
    ]

    Array.from(e.I).map(e => new Equipment(e)).forEach(equipment => {
        // Strictly only sell Common and Rare. Protect Epic, Legendary, Relic, and Unique!
        if (!sellableRarities.includes(equipment.rarity))
            return
        if (equipment.setID != -1)
            return

        sendXT("seq", JSON.stringify({EID:equipment.id, LID:-1, EX:0, LFID:-1}))
        equipmentSold++
    })
    console.log("equipmentSold", equipmentSold)
}

events.on("load", () => {
    sendXT("ggm", JSON.stringify({}))
    xtHandler.once("ggm", sellGems)
    sendXT("gei", JSON.stringify({}))
    xtHandler.once("gei", sellEquipment)
    
    setInterval(() => {
        sendXT("ggm", JSON.stringify({}))
        xtHandler.once("ggm", sellGems)
        sendXT("gei", JSON.stringify({}))
        xtHandler.once("gei", sellEquipment)
    }, 1000 * 10 * 30)
})