const { Model, DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/connection");
const bcrypt = require("bcryptjs");

class Users extends Model {
    async validPassword(password) {
        if (!this.password) return false; // OAuth/social users won't have a local password
        return bcrypt.compare(password, this.password);
    }
}

Users.init(
    {
        id: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
        },
        firstName: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        lastName: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        email: {
            type: DataTypes.STRING,
            allowNull: false,
            unique: true,
            validate: {
                isEmail: true,
            },
        },
        password: {
            type: DataTypes.STRING,
            allowNull: true, // Allow null for OAuth users
            validate: {
                len: [8],
            },
        },
        profilePicture: {
            type: DataTypes.STRING,
            allowNull: true,
            defaultValue: "https://example.com/default-profile.png",
        },
        profilePicturePublicId: {
            type: DataTypes.STRING,
            allowNull: true,
            // Stores Cloudinary public_id for deletion/versioning
        },
        profilePictureProvider: {
            type: DataTypes.STRING,
            allowNull: true,
            defaultValue: "cloudinary",
        },
        provider: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        providerId: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        isVerified: {
            type: DataTypes.BOOLEAN,
            allowNull: true,
            defaultValue: null,
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: true,
            defaultValue: Sequelize.fn("NOW")
          },
    },
    {
        sequelize,

        hooks: {
            beforeCreate: async (newUserData) => {
                if (newUserData.password) {
                    newUserData.password = await bcrypt.hash(newUserData.password, 10);
                }
                return newUserData;
            },
            beforeUpdate: async (updatedUserData) => {
                if (updatedUserData.changed("password") && updatedUserData.password) {
                    updatedUserData.password = await bcrypt.hash(updatedUserData.password, 10);
                }
                return updatedUserData;
            },
        },
        validate: {
            passwordRequiredForLocal() {
                if (!this.provider && !this.password) {
                    throw new Error('Password required for local accounts');
                }
            },
        },
    }
); 

module.exports = Users;

