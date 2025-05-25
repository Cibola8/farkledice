const moduleName = "farkledice";

Hooks.once("ready", () => {
    game.modules.get(moduleName).api = {
        farkle: () => {
            if (!game.modules.get(moduleName).api.farkleScorer)
                game.modules.get(moduleName).api.farkleScorer = new FarkleScorer();

            game.modules.get(moduleName).api.farkleScorer.render(true);
        },
    }

    game.socket.on(`module.${moduleName}`, (data) => {
        if (!game.modules.get(moduleName).api.farkleScorer)
            game.modules.get(moduleName).api.farkleScorer = new FarkleScorer();

        game.modules.get(moduleName).api.farkleScorer.socketEvents(data);
    });

    game.settings.registerMenu(moduleName, 'farklestart', {
        name: 'Farkle',
        label: 'FARKLE.start',
        hint: 'FARKLE.farkleHint',
        type: FarkleStart,
        restricted: true,
    });
})


class FarkleScorer extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "farkle-scorer",
        window: {
            contentClasses: ["farkle-scorer", "standard-form"],
            title: "Farkle",
            controls: [
                {
                    icon: 'fas fa-question',
                    label: 'FARKLE.help',
                    action: 'showHelp',
                },
                {
                    icon: 'fas fa-dice',
                    label: 'FARKLE.loadDice',
                    action: 'loadDice',
                    visible: () => game.user.isGM,
                },
            ],
            resizable: true,
        },
        position: {
            width: 400,
            height: 400,
        },
        actions: {
            startFarkle: this.startFarkle,
            rollDice: this.rollDice,
            endTurn: this.endTurn,
            keepDie: this.keepDie,
            endFarkle: this.endFarkle,
            showHelp: this.showHelp,
            loadDice: this.loadDice,
        },
    }

    get gameState() {
        return this._gameState;
    }

    set gameState(value) {
        const sync = !value.skipSync;
        if (!sync) delete value.skipSync;

        this._gameState = foundry.utils.mergeObject(this._gameState, value);

        if (sync) {
            game.socket.emit(`module.${moduleName}`, {
                type: 'sync',
                payload: {
                    gameState: this._gameState,
                    userId: game.user.id,
                },
            });
        }
        const event = this._gameState.event;
        if (event) {
            this._gameState.event = null;
            this.handleEvent(event);
        }
        this.render(true);
    }

    _initialState = {
        userTurn: null,
        users: [],
        currentDice: [],
        keptDice: [],
        remainingRolls: 3,
        rollLength: 6,
        score: 0,
        keepIndex: []
    }

    _gameState = {}

    socketEvents(data) {
        switch (data.type) {
            case 'sync':
                if (data.payload.userId !== game.user.id) {
                    const newState = data.payload.gameState;
                    newState.skipSync = true;
                    this.gameState = data.payload.gameState;
                }
                break;
            case 'close':
                this.close();
                break;
            default:
                break;
        }
    }

    static endFarkle(_ev, _target) {
        const users = this.gameState.users;
        if (users.some(user => user.score)) {
            const winner = users.reduce((prev, current) => (prev.score > current.score) ? prev : current);
            const winnerMessage = game.i18n.format("FARKLE.winner", { name: winner.name, score: winner.score });
            const content = `<p>${winnerMessage}</p><p><ul>${users.map(x => `<li><b>${x.name}</b>: ${x.score}</li>`)}</ul></p>`
            const chatMessage = { content };
            ChatMessage.create(chatMessage);
        }

        this._gameState = foundry.utils.duplicate(this._initialState);
        game.socket.emit(`module.${moduleName}`, {
            type: 'close',
            payload: { userId: game.user.id },
        });
        this.close();
    }

    static async showHelp(_ev, _target) {
        new FarkleHelp().render(true);
    }

    resetFarkle(users) {
        this._gameState = foundry.utils.duplicate(this._initialState);
        const state = {
            users,
            userTurn: 0,
            event: "start",
        }
        this.gameState = state;
    }

    static startFarkle(_ev, _target) {
        new PlayerPick().render(true);
    }

    get myTurn() {
        return this.gameState.users[this.gameState.userTurn]?.id === game.user.id;
    }

    handleEvent(event) {
        switch (event) {
            case "start":
                this.#startEvent();
                break;
            default:
                break;
        }
    }

    async showDiceSoNice(roll) {
        if (game.modules.get('dice-so-nice')?.active && game.dice3d) {
            const rollMode = game.settings.get('core', 'rollMode');
            let whisper = null;
            let blind = false;
            switch (rollMode) {
                case 'blindroll':
                    blind = true;
                    whisper = game.users.filter((user) => user.isGM).map((x) => x.id);
                    break;
                case 'gmroll':
                    whisper = game.users.filter((user) => user.isGM).map((x) => x.id);
                    break;
                case 'selfroll':
                    whisper = [];
                    break;
            }
            const promise = game.dice3d.showForRoll(roll, game.user, true, whisper, blind);
            if (!game.settings.get('dice-so-nice', 'immediatelyDisplayChatMessages')) await promise;
        }
    }


    async #startEvent() {
        this.cheats = {};
        const controlledActors = this.gameState.users.filter(user => user.id === game.user.id)
        if (controlledActors.length === 0) return;

        const actors = (await Promise.all(controlledActors.map(async (user) => {
            return await fromUuid(user.character_id);
        }))).filter(actor => {
            return actor && actor.items.some(item => foundry.utils.getProperty(item, 'flags.farkledice.loaded'));
        });
        if (!actors.length) return;

        new PickLoadedDice(actors).render(true);
    }

    static keepDie(_ev, target) {
        if (!this.myTurn) return;

        const isAdded = !target.classList.contains("kept");
        const keptDice = this.gameState.keptDice;
        const dieIndex = parseInt(target.dataset.index);

        if (isAdded) {
            keptDice.push(dieIndex);
        } else {
            const index = keptDice.indexOf(dieIndex);
            if (index > -1) {
                keptDice.splice(index, 1);
            }
        }

        const newState = {
            keptDice
        }

        if (keptDice.length === this.gameState.currentDice.length) {
            const isHotDice = this.isHotDice(this.gameState.currentDice)

            if (isHotDice) {
                newState.remainingRolls = 3;
                newState.rollLength = 6;
                newState.score = this.gameState.score + isHotDice;
                newState.keptDice = [];
                newState.currentDice = [];
                newState.keepIndex = [];
                newState.isHotDice = true;

                ui.notifications.warn(game.i18n.localize("FARKLE.diceAreBurning"));
            }
        }

        this.gameState = newState
    }

    static async loadDice(_ev, _target) {
        new DiceLoader().render(true);
    }

    async roll(rollLength, user) {
        const loadedDice = this.cheats[user.character_id];
        let roll;
        if (!loadedDice) {
            roll = await new Roll(`${rollLength}d6`).evaluate()
        } else {
            const pickLoadedDice = loadedDice.filter((die, index) => {
                return !this.gameState.keepIndex.includes(index);
            });
            const dies = Array(rollLength).fill('1d6');
            for (let i = 0; i < dies.length; i++) {
                if (loadedDice[i]) {
                    const weightSum = loadedDice[i].reduce((sum, current) => sum + current, 0);
                    dies[i] = `1d${weightSum}`;
                }
            }

            roll = await new Roll(dies.join('+')).evaluate();
        }

        const finalResults = [];
        let index = 0;
        for (let term of roll.terms) {
            if (term instanceof foundry.dice.terms.Die) {
                const currentLoadedDice = loadedDice ? loadedDice[index] : null;
                for (let die of term.results) {
                    let result = die.result;
                    if (currentLoadedDice) {
                        // map result to loaded dice weights 
                        let mappedRoll = 1;
                        while (mappedRoll <= currentLoadedDice.length && currentLoadedDice[mappedRoll - 1] < result) {
                            mappedRoll++;
                        }
                        result = mappedRoll;
                    }
                    die.result = result;
                    die.faces = 6
                    finalResults.push({
                        result: result,
                        loaded: !!currentLoadedDice
                    });
                }
                index += 1;
            }
        }
        this.showDiceSoNice(roll);
        return finalResults;
    }

    static async rollDice(_ev, _target) {
        if (this.gameState.keptDice.length === 0 && this.gameState.currentDice.length !== 0) {
            ui.notifications.warn(game.i18n.localize("FARKLE.noDiceKept"));
            return;
        }

        const calculatedScore = this.score();
        const newRollLength = this.gameState.rollLength - calculatedScore.usedIndexes.length;

        const currentPlayer = this.gameState.users[this.gameState.userTurn];
        const roll = await this.roll(newRollLength, currentPlayer);
        const data = {
            rolls: roll,
            msg: game.i18n.format('FARKLE.rolling', { name: currentPlayer.name, count: newRollLength })
        }

        const content = await foundry.applications.handlebars.renderTemplate("modules/farkledice/templates/rollMessage.hbs", data);

        await ChatMessage.create({
            content,
            sound: CONFIG.sounds.dice
        });
        const newState = {
            currentDice: roll.map(die => die.result),
            remainingRolls: this.gameState.remainingRolls - 1,
            rollLength: newRollLength,
            keptDice: [],
            keepIndex: [],
            score: this.gameState.score + this.score().score
        }
        if (this.isFarkle(newState.currentDice)) {
            newState.score = 0;
        }
        this.gameState = newState;
    }

    selectedDice() {
        const indexes = this.gameState.keptDice;
        const dice = this.gameState.currentDice || [];
        return dice.filter((_die, index) => indexes.includes(index));
    }

    static endTurn(_ev, _target) {

        let nextUser = this.gameState.userTurn + 1;
        if (nextUser >= this.gameState.users.length) {
            nextUser = 0;
        }
        const roundScore = this.score().score + this.gameState.score;
        const user = this.gameState.users[this.gameState.userTurn]
        user.score += roundScore;
        this.gameState = {
            userTurn: nextUser,
            remainingRolls: 3,
            rollLength: 6,
            score: 0,
            currentDice: [],
            keptDice: [],
            keepIndex: [],
            isHotDice: false,
        }
    }

    static PARTS = {
        main: {
            root: true,
            template: "modules/farkledice/templates/main.hbs",
        }
    }

    isHotDice(throws) {
        if (throws.length === 0) return false;

        const selectedIndexes = throws.map((die, index) => index);
        const score = this.scoreCalc(selectedIndexes, throws);
        if (score.usedIndexes.length === throws.length && score.score > 0) return score.score;

        return false;
    }

    isFarkle(throws) {
        const dice = throws ?? this.gameState.currentDice ?? [];
        if (dice.length === 0) return false;

        const selectedIndexes = dice.map((die, index) => index);
        return this.scoreCalc(selectedIndexes, dice).score === 0;
    }

    async _prepareContext(options) {
        const data = await super._prepareContext(options);
        const currentScore = this.score()
        data.started = foundry.utils.isEmpty(this.gameState) === false;
        data.gameState = this.gameState;
        data.isGm = game.user.isGM;
        if (data.started) {
            data.currentPlayer = this.gameState.users[this.gameState.userTurn];
            data.currentUser = game.users.get(data.currentPlayer?.id);
            data.currentTurnPoints = currentScore.score + data.gameState.score;
            const character = data.currentPlayer?.character_id ? await fromUuid(data.currentPlayer.character_id) : data.currentUser?.character;
            data.currentUserURL = character?.img || data.currentUser?.avatar;
            data.allowedToRoll = this.gameState.remainingRolls > 0;
            data.myTurn = this.myTurn;
        }
        data.isFarkle = this.isFarkle();
        if (this.gameState.currentDice?.length) {
            data.currentDice = this.gameState.currentDice?.map((die, index) => {
                const isKept = this.gameState.keptDice.includes(index);
                const invalid = !currentScore.usedIndexes.includes(index);
                const cssClass = []
                if (isKept) {
                    cssClass.push('kept');
                }
                if (invalid) {
                    cssClass.push('invalid');
                }
                return {
                    die,
                    cssClass: cssClass.join(' '),
                }
            })
        } else {
            data.currentDice = ['?', '?', '?', '?', '?', '?'].map((die, index) => {
                return {
                    die,
                    cssClass: 'waiting'
                }
            })
        }
        return data;
    }

    score() {
        const indexes = this.gameState.keptDice;
        const dice = this.gameState.currentDice || [];
        return this.scoreCalc(indexes, dice);
    }

    scoreCalc(selectedIndexes, dice) {
        if (!Array.isArray(dice) || dice.length === 0 || !selectedIndexes.length)
            return { score: 0, usedIndexes: [] };

        // Only consider dice that are in the selectedIndexes array
        const selectedDice = selectedIndexes.map(index => ({
            value: dice[index],
            index
        })).filter(d => d.value >= 1 && d.value <= 6);

        if (selectedDice.length === 0) return { score: 0, usedIndexes: [] };

        const counts = Array(7).fill(0);
        for (let die of selectedDice) {
            counts[die.value]++;
        }

        let score = 0;
        let usedIndexes = [];

        // Check for straight (1-2-3-4-5-6)
        if (selectedDice.length === 6 && counts.slice(1).every(count => count === 1)) {
            return { score: 1500, usedIndexes: selectedDice.map(d => d.index) };
        }

        // Check for three pairs
        if (selectedDice.length === 6 && counts.filter(count => count === 2).length === 3) {
            return { score: 1500, usedIndexes: selectedDice.map(d => d.index) };
        }

        // Check for two triplets
        if (selectedDice.length === 6 && counts.filter(count => count === 3).length === 2) {
            return { score: 2500, usedIndexes: selectedDice.map(d => d.index) };
        }

        // Check for four of a kind + pair
        if (selectedDice.length === 6 && counts.includes(4) && counts.includes(2)) {
            return { score: 1500, usedIndexes: selectedDice.map(d => d.index) };
        }

        // Process sets of 3 or more
        for (let i = 1; i <= 6; i++) {
            if (counts[i] >= 3) {
                let baseScore = i === 1 ? 1000 : i * 100;
                switch (counts[i]) {
                    case 6: score += baseScore * 4; break;
                    case 5: score += baseScore * 3; break;
                    case 4: score += baseScore * 2; break;
                    case 3: score += baseScore; break;
                }

                // Mark these dice as used
                const diceOfThisValue = selectedDice.filter(d => d.value === i);
                usedIndexes = usedIndexes.concat(diceOfThisValue.slice(0, counts[i]).map(d => d.index));

                counts[i] = 0; // Mark these as processed
            }
        }

        // Process individual 1s and 5s
        for (let i of [1, 5]) {
            if (counts[i] > 0) {
                score += (i === 1 ? 100 : 50) * counts[i];

                // Mark these dice as used
                const diceOfThisValue = selectedDice
                    .filter(d => d.value === i && !usedIndexes.includes(d.index));
                usedIndexes = usedIndexes.concat(diceOfThisValue.slice(0, counts[i]).map(d => d.index));
            }
        }

        return { score, usedIndexes };
    }
}


class FarkleHelp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
    static DEFAULT_OPTIONS = {
        window: {
            contentClasses: ["farkle-scorer", "standard-form"],
            title: "FARKLE.help",
        },
        position: {
            width: 500,
        }
    }

    static PARTS = {
        main: {
            template: "modules/farkledice/templates/description.hbs",
        }
    }
}

class PlayerPick extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
    static DEFAULT_OPTIONS = {
        window: {
            contentClasses: ["farkle-scorer", "standard-form"],
            title: "FARKLE.playerPick",
        },
        position: {
            width: 500,
        },
        actions: {
            confirmSelection: this.confirmSelection,
            cancelSelection: this.cancelSelection,
            addPlayer: this.addPlayer,
        }
    }

    static PARTS = {
        main: {
            template: "modules/farkledice/templates/playerPick.hbs",
            templates: ["modules/farkledice/templates/playerrow.hbs"]
        }
    }

    static confirmSelection(_ev, target) {
        const userDivs = this.element.querySelectorAll('.player');
        const users = []
        for (let player of userDivs) {
            const selected = player.querySelector('.selectPlayer').checked;
            if (!selected) continue;

            const playerId = player.querySelector('.representedBy').value;
            const name = player.querySelector('.playerName').value;
            users.push({
                id: playerId,
                name,
                score: 0,
                character_id: player.dataset.characteruuid
            })
        }
        game.modules.get(moduleName).api.farkleScorer.resetFarkle(users);
        this.close();
    }

    static cancelSelection(_ev, target) {
        this.close();
    }

    get availablePlayers() {
        return game.users.filter(x => x.active).map((user) => {
            return {
                id: user.id,
                name: user.name,
                characterName: user.character?.name || user.name,
                avatar: user.avatar || user.character?.img,
                character_id: user.character?.uuid,
            }
        })
    }

    async _prepareContext(options) {
        const data = await super._prepareContext(options);
        data.players = this.availablePlayers;
        return data;
    }

    static async addPlayer(_ev, target) {
        this._addRow({
            id: game.user.id,
            avatar: game.user.character?.img || game.user.avatar,
            character_id: game.user.character?.uuid,
        });
    }

    async _addRow(player) {
        const addAfter = this.element.querySelector('.player:last-child');

        const newRow = await foundry.applications.handlebars.renderTemplate("modules/farkledice/templates/playerrow.hbs", {
            players: this.availablePlayers,
            player
        });

        addAfter.insertAdjacentHTML('afterend', newRow);
    }


    _canDragStart() {
        return false;
    }

    _canDragDrop() {
        return true;
    }

    async _onRender(context, options) {
        await super._onRender(context, options);

        new foundry.applications.ux.DragDrop.implementation({
            dragSelector: null,
            dropSelector: ".window-content",
            permissions: {
                dragstart: this._canDragStart.bind(this),
                drop: this._canDragDrop.bind(this)
            },
            callbacks: {
                dragstart: this._onDragStart.bind(this),
                dragover: this._onDragOver.bind(this),
                drop: this._onDrop.bind(this)
            }
        }).bind(this.element);
    }

    async _onDragStart(event) {
    }

    _onDragOver(event) {
    }

    async _onDrop(event) {
        const dragData = JSON.parse(event.dataTransfer.getData('text/plain'));

        if (!dragData.type == 'Actor') return;

        const actor = await Actor.implementation.fromDropData(dragData);

        const ownerIDs = Object.keys(actor.ownership)
        const lastOwner = ownerIDs.length ? ownerIDs[ownerIDs.length - 1] : null;

        const player = {
            id: lastOwner || game.user.id,
            characterName: actor.name,
            avatar: actor.img,
            character_id: actor.uuid,
        }

        this._addRow(player)
    }
}

class FarkleStart extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
    async render(options) {
        game.modules.get(moduleName).api.farkle()
    }
}

class DiceLoader extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
    static DEFAULT_OPTIONS = {
        window: {
            contentClasses: ["farkle-scorer", "standard-form"],
            title: "FARKLE.loadDice",
        },
        position: {
            width: 500,
        },
        actions: {
            clearLoaded: this.clearLoaded,
            loadDice: this.loadDice,
        }
    }

    static PARTS = {
        main: {
            template: "modules/farkledice/templates/diceLoader.hbs",
        }
    }

    async _prepareContext(options) {
        const data = await super._prepareContext(options);
        data.item = this.item;
        const loaded = this.item?.flags?.farkledice?.loaded || [];
        const weigths = loaded.length ? loaded : [1, 1, 1, 1, 1, 1];
        const weightSum = weigths.reduce((sum, current) => sum + current, 0);
        data.sides = weigths.map((weight, index) => {
            return {
                index: index + 1,
                weight,
                cssClass: weight > 1 ? 'load' : '',
                probability: (weight / weightSum * 100).toFixed(1),
            }
        })
        console.log(data)
        return data;
    }

    static async clearLoaded(_ev, target) {
        await this.item.update({ [`flags.-=farkledice`]: null });
        this.render(true);
    }

    static async loadDice(_ev, target) {
        const loads = this.element.querySelectorAll('.load')
        const values = Array.from(loads).map(x => parseInt(x.value) || 1);
        await this.item.update({
            [`flags.farkledice.loaded`]: values
        });
        ui.notifications.info(game.i18n.localize("FARKLE.loadedDice"));
        this.render(true);
    }

    _canDragStart() {
        return false;
    }

    _canDragDrop() {
        return true;
    }

    async _onRender(context, options) {
        await super._onRender(context, options);

        new foundry.applications.ux.DragDrop.implementation({
            dragSelector: null,
            dropSelector: ".window-content",
            permissions: {
                dragstart: this._canDragStart.bind(this),
                drop: this._canDragDrop.bind(this)
            },
            callbacks: {
                dragstart: this._onDragStart.bind(this),
                dragover: this._onDragOver.bind(this),
                drop: this._onDrop.bind(this)
            }
        }).bind(this.element);

        this.element.querySelectorAll('.load').forEach(input => {
            input.addEventListener('change', (ev) => {
                const allWeights = Array.from(this.element.querySelectorAll('.load')).map(x => parseInt(x.value) || 1);
                const weightSum = allWeights.reduce((sum, current) => sum + current, 0);

                this.element.querySelectorAll('.load').forEach((el, index) => {
                    const newWeight = parseInt(el.value) || 1;
                    const newProbability = (newWeight / weightSum * 100).toFixed(1);
                    const parent = el.closest('.flexrow');
                    parent.querySelector('.probability').textContent = `${newProbability} %`; 
                })
            });
        });
    }

    async _onDragStart(event) {
    }

    _onDragOver(event) {
    }

    async _onDrop(event) {
        const dragData = JSON.parse(event.dataTransfer.getData('text/plain'));

        if (!dragData.type == 'Item') return;

        const item = await Item.implementation.fromDropData(dragData);

        this.item = item;
        this.render(true);
    }

}

class PickLoadedDice extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
    static DEFAULT_OPTIONS = {
        window: {
            contentClasses: ["farkle-scorer", "standard-form"],
            title: "FARKLE.pickLoadedDice",
        },
        position: {
            width: 500,
        },
        actions: {
            confirmSelection: this.confirmSelection,
            pickDie: this.pickDie,
        }
    }

    static PARTS = {
        main: {
            template: "modules/farkledice/templates/pickLoadedDice.hbs",
        }
    }

    constructor(actors) {
        super();
        this.actors = actors;
    }

    async _prepareContext(options) {
        const data = await super._prepareContext(options);
        data.actors = this.actors.map(actor => {
            return {
                name: actor.name,
                img: actor.img,
                uuid: actor.uuid,
                loaded: actor.items.filter(item => foundry.utils.getProperty(item, 'flags.farkledice.loaded')).map(item => {
                    return {
                        uuid: item.uuid,
                        name: item.name,
                        img: item.img || "icons/svg/dice-target.svg",
                    }
                })
            }
        })
        return data;
    }

    static pickDie(_ev, target) {
        const maxPicks = 6;
        const actorContainer = target.closest('[data-uuid]');
        const selected = actorContainer.querySelectorAll('.picked');
        if (selected.length >= maxPicks) {
            return;
        }
        target.classList.toggle('picked');
    }

    static async confirmSelection(_ev, target) {
        const actors = this.element.querySelectorAll('[data-uuid]');

        const cheats = {}

        for (let actor of actors) {
            const selected = actor.querySelectorAll('.picked');
            if (selected.length === 0) continue;

            const uuid = actor.dataset.uuid;
            const items = await Promise.all(Array.from(selected).map(async (die) => {
                return await fromUuid(die.dataset.die);
            }));


            const loadedDice = items.map(item => {
                return item.flags.farkledice.loaded || [1, 1, 1, 1, 1, 1];
            });
            const loadedWithIndex = [];
            for (let i = 0; i < loadedDice.length; i++) {
                const randomIndex = Math.floor(Math.random() * 6);
                while (loadedWithIndex[randomIndex]) {
                    randomIndex = Math.floor(Math.random() * 6);
                }
                loadedWithIndex[randomIndex] = loadedDice[i];
            }

            cheats[uuid] = loadedWithIndex;
        }
        game.modules.get(moduleName).api.farkleScorer.cheats = cheats;
        this.close();
    }
}